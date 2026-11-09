// The lots summary (lots by side and option type), shared by the table on screen and the JPEG export.

const lotsFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** A lots figure as shown: '…' while the lot sizes are still loading. */
export function formatLots(lots, value) {
  return lots.pending ? '…' : lotsFormat.format(value);
}

/**
 * The SELL, BUY and Total rows, each { key, label, CE, PE, total }.
 * `lots` is { sell: { CE, PE }, buy: { CE, PE }, missing, pending }.
 */
export function lotsRows(lots) {
  return [
    { key: 'sell', label: 'SELL', ...lots.sell },
    { key: 'buy', label: 'BUY', ...lots.buy },
    { key: 'total', label: 'Total', CE: lots.sell.CE + lots.buy.CE, PE: lots.sell.PE + lots.buy.PE },
  ].map((row) => ({ ...row, total: row.CE + row.PE }));
}
