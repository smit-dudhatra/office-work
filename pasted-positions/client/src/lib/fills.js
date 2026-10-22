// Cells keep their background colour from Excel / the web page, in light and dark mode alike,
// so their text colour is picked to read well on that colour rather than on the page.

// The light and dark theme text / P&L colours from styles.css
const ON_LIGHT = { text: '#191c22', pos: '#11773b', neg: '#c22a2a' };
const ON_DARK = { text: '#e6e8ed', pos: '#4cc27e', neg: '#ff6f6f' };
// Below this contrast against the fill, green / red is hard to read and the plain text colour is used
const MIN_SIGN_CONTRAST = 3;

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const styles = new Map();

/** Inline style for a cell with a fill ('#RRGGBB'); `sign` is 'pos' / 'neg' for green / red P&L text. */
export function fillStyle(fill, sign) {
  const key = `${fill} ${sign}`;
  if (!styles.has(key)) {
    const palette = contrast(fill, ON_LIGHT.text) >= contrast(fill, ON_DARK.text) ? ON_LIGHT : ON_DARK;
    const color = sign && contrast(fill, palette[sign]) >= MIN_SIGN_CONTRAST ? palette[sign] : palette.text;
    styles.set(key, { backgroundColor: fill, color });
  }
  return styles.get(key);
}
