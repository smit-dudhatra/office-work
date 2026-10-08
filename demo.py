#!/usr/bin/env python3
"""
World Clock relative to IST (Indian Standard Time)
----------------------------------------------------
Prints two tables to the console, then exits. Each row shows the city's
current local time (24-hour clock), its offset from IST, and the season
it is currently experiencing (with a typical date range for that season):

  1. Every configured city, sorted by offset from IST
     (most behind -> IST -> most ahead).
  2. A filtered table showing only cities whose *local hour of day*
     currently falls within [MIN_HOUR, MAX_HOUR].

Season/period values are typical climatological averages for each city's
region (e.g. monsoon for South/Southeast Asia, wet/dry for the tropics,
hot/mild for deserts, spring/summer/autumn/winter for temperate zones) -
not an exact forecast for the current year.

Requires Python 3.9+ (uses the standard-library `zoneinfo` module).
"""

import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# --------------------------------------------------------------------------
# CONFIG - edit these to change behaviour
# --------------------------------------------------------------------------

# Local-hour filter for the second table (24-hour clock, inclusive on both ends).
# Example: 12 and 18 -> keep cities where it is currently between 12:00 and
# 18:00 local time (their afternoon).
MIN_HOUR = 12
MAX_HOUR = 18

# City -> IANA timezone name. Add/remove entries here to change the city list.
CITY_TIMEZONES = {
    "Seoul": "Asia/Seoul",
    "Hong Kong": "Asia/Hong_Kong",
    "Chengdu": "Asia/Shanghai",
    "Shanghai": "Asia/Shanghai",
    "Shenzhen": "Asia/Shanghai",
    "Kuala Lumpur": "Asia/Kuala_Lumpur",
    "Tokyo": "Asia/Tokyo",
    "Ankara": "Europe/Istanbul",
    "Guangzhou": "Asia/Shanghai",
    "Cape Town": "Africa/Johannesburg",
    "London": "Europe/London",
    "Taipei": "Asia/Taipei",
    "Madrid": "Europe/Madrid",
    "Singapore": "Asia/Singapore",
    "Chongqing": "Asia/Shanghai",
    "Paris": "Europe/Paris",
    "Istanbul": "Europe/Istanbul",
    "Chicago": "America/Chicago",
    "Moscow": "Europe/Moscow",
    "Munich": "Europe/Berlin",
    "Qingdao": "Asia/Shanghai",
    "Jeddah": "Asia/Riyadh",
    "Busan": "Asia/Seoul",
    "Atlanta": "America/New_York",
    "Wuhan": "Asia/Shanghai",
    "Manila": "Asia/Manila",
    "Beijing": "Asia/Shanghai",
    "Toronto": "America/Toronto",
    "Milan": "Europe/Rome",
    "Warsaw": "Europe/Warsaw",
    "Dallas": "America/Chicago",
    "Los Angeles": "America/Los_Angeles",
    "Denver": "America/Denver",
    "Tel Aviv": "Asia/Jerusalem",
    "Karachi": "Asia/Karachi",
    "Helsinki": "Europe/Helsinki",
    "Amsterdam": "Europe/Amsterdam",
    "New York City": "America/New_York",
    "Sao Paulo": "America/Sao_Paulo",
    "Miami": "America/New_York",
    "Lucknow": "Asia/Kolkata",
    "Buenos Aires": "America/Argentina/Buenos_Aires",
    "Mexico City": "America/Mexico_City",
    "Seattle": "America/Los_Angeles",
    "San Francisco": "America/Los_Angeles",
    "Houston": "America/Chicago",
    "Austin": "America/Chicago",
    "Panama City": "America/Panama",
    "Wellington": "Pacific/Auckland",
}

# City -> climate/season profile key (see SEASON_PROFILES below).
# Most cities use the standard 4-season temperate pattern; a few climate
# zones (South Asian monsoon, equatorial monsoon, desert, tropical wet/dry)
# get their own regionally accurate profile.
CITY_SEASON_PROFILE = {
    "Seoul": "north_temperate",
    "Hong Kong": "north_temperate",
    "Chengdu": "north_temperate",
    "Shanghai": "north_temperate",
    "Shenzhen": "north_temperate",
    "Kuala Lumpur": "equatorial_monsoon",
    "Tokyo": "north_temperate",
    "Ankara": "north_temperate",
    "Guangzhou": "north_temperate",
    "Cape Town": "south_temperate",
    "London": "north_temperate",
    "Taipei": "north_temperate",
    "Madrid": "north_temperate",
    "Singapore": "equatorial_monsoon",
    "Chongqing": "north_temperate",
    "Paris": "north_temperate",
    "Istanbul": "north_temperate",
    "Chicago": "north_temperate",
    "Moscow": "north_temperate",
    "Munich": "north_temperate",
    "Qingdao": "north_temperate",
    "Jeddah": "me_desert",
    "Busan": "north_temperate",
    "Atlanta": "north_temperate",
    "Wuhan": "north_temperate",
    "Manila": "philippines_wet_dry",
    "Beijing": "north_temperate",
    "Toronto": "north_temperate",
    "Milan": "north_temperate",
    "Warsaw": "north_temperate",
    "Dallas": "north_temperate",
    "Los Angeles": "north_temperate",
    "Denver": "north_temperate",
    "Tel Aviv": "north_temperate",
    "Karachi": "pakistan_monsoon",
    "Helsinki": "north_temperate",
    "Amsterdam": "north_temperate",
    "New York City": "north_temperate",
    "Sao Paulo": "south_temperate",
    "Miami": "tropical_wet_dry_us",
    "Lucknow": "india_monsoon",
    "Buenos Aires": "south_temperate",
    "Mexico City": "tropical_wet_dry_us",
    "Seattle": "north_temperate",
    "San Francisco": "north_temperate",
    "Houston": "north_temperate",
    "Austin": "north_temperate",
    "Panama City": "panama_wet_dry",
    "Wellington": "south_temperate",
}

# Each profile is an ordered list of (season_name, (start_month, start_day),
# (end_month, end_day), human_readable_period). Ranges are typical
# climatological averages, not exact for any single year, and may wrap
# across the New Year (e.g. Dec -> Feb).
SEASON_PROFILES = {
    # Standard meteorological 4 seasons, Northern Hemisphere.
    "north_temperate": [
        ("Spring", (3, 1), (5, 31), "March to May"),
        ("Summer", (6, 1), (8, 31), "June to August"),
        ("Autumn", (9, 1), (11, 30), "September to November"),
        ("Winter", (12, 1), (2, 28), "December to February"),
    ],
    # Standard 4 seasons, reversed for the Southern Hemisphere.
    "south_temperate": [
        ("Autumn", (3, 1), (5, 31), "March to May"),
        ("Winter", (6, 1), (8, 31), "June to August"),
        ("Spring", (9, 1), (11, 30), "September to November"),
        ("Summer", (12, 1), (2, 28), "December to February"),
    ],
    # North India (IMD-style 4 seasons).
    "india_monsoon": [
        ("Winter", (12, 1), (2, 28), "December to February"),
        ("Summer (Pre-Monsoon)", (3, 1), (5, 31), "March to May"),
        ("Monsoon", (6, 1), (9, 15), "June to mid-September"),
        ("Post-Monsoon (Autumn)", (9, 16), (11, 30), "mid-September to November"),
    ],
    # Pakistan: similar 4-part pattern, monsoon arrives later and weaker.
    "pakistan_monsoon": [
        ("Winter (Mild)", (12, 1), (2, 28), "December to February"),
        ("Summer (Pre-Monsoon)", (3, 1), (6, 30), "March to June"),
        ("Monsoon", (7, 1), (9, 15), "July to mid-September"),
        ("Post-Monsoon (Autumn)", (9, 16), (11, 30), "mid-September to November"),
    ],
    # Equatorial Southeast Asia (Singapore, Kuala Lumpur).
    "equatorial_monsoon": [
        ("Northeast Monsoon (Wetter)", (11, 1), (3, 15), "November to mid-March"),
        ("Inter-Monsoon (Transitional)", (3, 16), (5, 31), "mid-March to May"),
        ("Southwest Monsoon (Drier)", (6, 1), (9, 30), "June to September"),
        ("Inter-Monsoon (Transitional)", (10, 1), (10, 31), "October"),
    ],
    # Philippines (PAGASA-style: cool dry / hot dry / wet monsoon).
    "philippines_wet_dry": [
        ("Cool Dry Season", (12, 1), (2, 28), "December to February"),
        ("Hot Dry Season", (3, 1), (5, 31), "March to May"),
        ("Wet Season (Monsoon)", (6, 1), (11, 30), "June to November"),
    ],
    # Hot desert, Arabian Peninsula (e.g. Jeddah).
    "me_desert": [
        ("Hot Season", (4, 1), (10, 31), "April to October"),
        ("Mild Season", (11, 1), (3, 31), "November to March"),
    ],
    # Tropical wet/dry (Miami, Mexico City).
    "tropical_wet_dry_us": [
        ("Wet Season", (5, 1), (10, 31), "May to October"),
        ("Dry Season", (11, 1), (4, 30), "November to April"),
    ],
    # Panama: dry/wet split centred on mid-month boundaries.
    "panama_wet_dry": [
        ("Dry Season", (12, 15), (4, 15), "mid-December to mid-April"),
        ("Wet Season", (4, 16), (12, 14), "mid-April to mid-December"),
    ],
}


def get_current_season(profile_key: str, month: int, day: int):
    """Return (season_name, period_label) for the given profile and date."""
    today = (month, day)
    for name, start, end, period in SEASON_PROFILES[profile_key]:
        if start <= end:
            if start <= today <= end:
                return name, period
        else:
            # Range wraps across the New Year (e.g. Dec 1 -> Feb 28).
            if today >= start or today <= end:
                return name, period
    # Should never happen if profiles cover the full year, but fail safely.
    return "Unknown", "-"


try:
    IST = ZoneInfo("Asia/Kolkata")
except ZoneInfoNotFoundError:
    sys.exit(
        "Missing timezone database.\n"
        "Windows Python does not ship IANA timezone data by default.\n"
        "Fix: run this once, then re-run this script:\n\n"
        "    pip install tzdata\n"
    )

# --------------------------------------------------------------------------


def format_offset(delta_seconds: float) -> str:
    """Turn a signed offset (city - IST, in seconds) into a readable label
    like '3 hours 30 minutes ahead of IST' / '12 hours behind of IST' / 'IST'."""
    if delta_seconds == 0:
        return "IST"

    direction = "ahead" if delta_seconds > 0 else "behind"
    total_minutes = round(abs(delta_seconds) / 60)
    hours, minutes = divmod(total_minutes, 60)

    parts = []
    if hours:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    if minutes:
        parts.append(f"{minutes} minute{'s' if minutes != 1 else ''}")
    if not parts:
        parts.append("0 minutes")

    return f"{' '.join(parts)} {direction} of IST"


def gather_city_data():
    """Return a list of dicts (city, local datetime, local hour, IST offset),
    sorted from most-behind-IST to most-ahead-of-IST."""
    utc_now = datetime.now(timezone.utc)
    ist_offset = utc_now.astimezone(IST).utcoffset()

    rows = []
    for city, tz_name in CITY_TIMEZONES.items():
        local_now = utc_now.astimezone(ZoneInfo(tz_name))
        offset_delta = local_now.utcoffset() - ist_offset
        profile_key = CITY_SEASON_PROFILE[city]
        season_name, season_period = get_current_season(
            profile_key, local_now.month, local_now.day
        )
        rows.append(
            {
                "city": city,
                "local_dt": local_now,
                "hour": local_now.hour,
                "offset_seconds": offset_delta.total_seconds(),
                "offset_label": format_offset(offset_delta.total_seconds()),
                "season": season_name,
                "period": season_period,
            }
        )

    rows.sort(key=lambda r: r["offset_seconds"])
    return rows


def print_table(rows, title):
    print(f"\n{title}")
    print("=" * len(title))

    if not rows:
        print("(no cities to display)")
        return

    formatted = [
        {
            "city": r["city"],
            "time": r["local_dt"].strftime("%a %d %b %Y, %H:%M:%S"),
            "offset": r["offset_label"],
            "season": r["season"],
            "period": r["period"],
        }
        for r in rows
    ]

    city_w = max(len("City"), max(len(r["city"]) for r in formatted))
    time_w = max(len("Local Time"), max(len(r["time"]) for r in formatted))
    offset_w = max(len("Offset from IST"), max(len(r["offset"]) for r in formatted))
    season_w = max(len("Season"), max(len(r["season"]) for r in formatted))
    period_w = max(len("Period"), max(len(r["period"]) for r in formatted))

    header = (
        f"{'City':<{city_w}}  {'Local Time':<{time_w}}  "
        f"{'Offset from IST':<{offset_w}}  {'Season':<{season_w}}  {'Period':<{period_w}}"
    )
    print(header)
    print("-" * len(header))

    for r in formatted:
        print(
            f"{r['city']:<{city_w}}  {r['time']:<{time_w}}  "
            f"{r['offset']:<{offset_w}}  {r['season']:<{season_w}}  {r['period']:<{period_w}}"
        )


def main():
    rows = gather_city_data()

    print_table(rows, "All Cities - Sorted by Offset from IST")

    filtered = [r for r in rows if MIN_HOUR <= r["hour"] <= MAX_HOUR]
    print_table(
        filtered,
        f"Filtered - Local Hour Between {MIN_HOUR:02d}:00 and {MAX_HOUR:02d}:00",
    )


if __name__ == "__main__":
    main()