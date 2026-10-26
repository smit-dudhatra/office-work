import { VelaWorkspace } from '@luxalgo/vela/workspace';
import { DemoProvider } from './data/demo-provider';

const workspace = new VelaWorkspace('#chart', {
    layout: '1',
    symbol: 'NSE:NIFTY',
    timeframe: '5',
    live: true,
    theme: 'dark',
    timezone: 'Asia/Kolkata',
    providers: { demo: () => new DemoProvider() },
    persist: 'chart-platform',
    autofocus: true,
});

// Handy for poking at the API from the browser console: `workspace.chart`, `workspace.cells()`…
Object.assign(window, { workspace });
