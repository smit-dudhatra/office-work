/**
 * The dummy instrument catalog. Prices and volatilities are rough, plausible
 * values — not market data. Swap this file (and the demo provider) for a real
 * broker feed when one is wired in.
 */
export interface DemoSymbol {
    ticker: string;
    prefix: string;
    description: string;
    type: 'index' | 'stock' | 'commodity' | 'crypto';
    currency: string;
    /** Price the live feed starts from on page load. */
    basePrice: number;
    /** Minimum price increment. */
    tick: number;
    /** Annualized volatility (0.20 = 20%). */
    vol: number;
    /** Annualized drift, used to make history trend up over the long run. */
    drift: number;
    /** Average traded volume per minute. */
    volumePerMin: number;
}

export const DEMO_SYMBOLS: DemoSymbol[] = [
    { ticker: 'NIFTY', prefix: 'NSE', description: 'Nifty 50 Index', type: 'index', currency: 'INR', basePrice: 25800, tick: 0.05, vol: 0.16, drift: 0.11, volumePerMin: 450_000 },
    { ticker: 'BANKNIFTY', prefix: 'NSE', description: 'Nifty Bank Index', type: 'index', currency: 'INR', basePrice: 57500, tick: 0.05, vol: 0.2, drift: 0.12, volumePerMin: 220_000 },
    { ticker: 'FINNIFTY', prefix: 'NSE', description: 'Nifty Financial Services Index', type: 'index', currency: 'INR', basePrice: 27100, tick: 0.05, vol: 0.19, drift: 0.11, volumePerMin: 90_000 },
    { ticker: 'SENSEX', prefix: 'BSE', description: 'S&P BSE Sensex', type: 'index', currency: 'INR', basePrice: 84500, tick: 0.05, vol: 0.15, drift: 0.11, volumePerMin: 120_000 },
    { ticker: 'RELIANCE', prefix: 'NSE', description: 'Reliance Industries Ltd', type: 'stock', currency: 'INR', basePrice: 1480, tick: 0.05, vol: 0.26, drift: 0.13, volumePerMin: 32_000 },
    { ticker: 'TCS', prefix: 'NSE', description: 'Tata Consultancy Services Ltd', type: 'stock', currency: 'INR', basePrice: 3100, tick: 0.05, vol: 0.24, drift: 0.12, volumePerMin: 9_000 },
    { ticker: 'HDFCBANK', prefix: 'NSE', description: 'HDFC Bank Ltd', type: 'stock', currency: 'INR', basePrice: 990, tick: 0.05, vol: 0.24, drift: 0.13, volumePerMin: 48_000 },
    { ticker: 'ICICIBANK', prefix: 'NSE', description: 'ICICI Bank Ltd', type: 'stock', currency: 'INR', basePrice: 1380, tick: 0.05, vol: 0.27, drift: 0.16, volumePerMin: 30_000 },
    { ticker: 'INFY', prefix: 'NSE', description: 'Infosys Ltd', type: 'stock', currency: 'INR', basePrice: 1500, tick: 0.05, vol: 0.28, drift: 0.12, volumePerMin: 21_000 },
    { ticker: 'SBIN', prefix: 'NSE', description: 'State Bank of India', type: 'stock', currency: 'INR', basePrice: 920, tick: 0.05, vol: 0.3, drift: 0.14, volumePerMin: 40_000 },
    { ticker: 'TATAMOTORS', prefix: 'NSE', description: 'Tata Motors Ltd', type: 'stock', currency: 'INR', basePrice: 680, tick: 0.05, vol: 0.38, drift: 0.15, volumePerMin: 55_000 },
    { ticker: 'ITC', prefix: 'NSE', description: 'ITC Ltd', type: 'stock', currency: 'INR', basePrice: 410, tick: 0.05, vol: 0.22, drift: 0.1, volumePerMin: 60_000 },
    { ticker: 'LT', prefix: 'NSE', description: 'Larsen & Toubro Ltd', type: 'stock', currency: 'INR', basePrice: 3900, tick: 0.05, vol: 0.27, drift: 0.15, volumePerMin: 6_000 },
    { ticker: 'CRUDEOIL', prefix: 'MCX', description: 'Crude Oil Futures', type: 'commodity', currency: 'INR', basePrice: 5600, tick: 1, vol: 0.35, drift: 0.04, volumePerMin: 1_800 },
    { ticker: 'GOLD', prefix: 'MCX', description: 'Gold Futures', type: 'commodity', currency: 'INR', basePrice: 121000, tick: 1, vol: 0.16, drift: 0.09, volumePerMin: 400 },
    { ticker: 'BTCUSD', prefix: 'CRYPTO', description: 'Bitcoin / US Dollar', type: 'crypto', currency: 'USD', basePrice: 110000, tick: 0.5, vol: 0.55, drift: 0.3, volumePerMin: 35 },
];
