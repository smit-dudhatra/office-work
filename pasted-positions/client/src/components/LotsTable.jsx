const lotsFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/**
 * Lots of the pasted positions by side and option type, every position whatever the filter.
 * `lots` is { sell: { CE, PE }, buy: { CE, PE }, missing, pending }: `missing` counts rows with no lot size,
 * `pending` is true while lot sizes are still loading.
 */
export default function LotsTable({ lots }) {
  const figure = (value) => (lots.pending ? '…' : lotsFormat.format(value));
  const rows = [
    { key: 'sell', label: 'SELL', ...lots.sell },
    { key: 'buy', label: 'BUY', ...lots.buy },
  ];
  const total = { CE: lots.sell.CE + lots.buy.CE, PE: lots.sell.PE + lots.buy.PE };
  return (
    <section className="lots-summary" aria-label="Lots by side and option type">
      <table className="lots-table">
        <thead>
          <tr>
            <th scope="col" className="lots-corner">Lots</th>
            <th scope="col">CE</th>
            <th scope="col">PE</th>
            <th scope="col" className="lots-total">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <span className={`side-tag is-${row.key}`}>{row.label}</span>
              </th>
              <td>{figure(row.CE)}</td>
              <td>{figure(row.PE)}</td>
              <td className="lots-total">{figure(row.CE + row.PE)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td>{figure(total.CE)}</td>
            <td>{figure(total.PE)}</td>
            <td className="lots-total">{figure(total.CE + total.PE)}</td>
          </tr>
        </tfoot>
      </table>
      {!lots.pending && lots.missing > 0 && (
        <p className="delta-note">
          {lots.missing} row{lots.missing === 1 ? ' has' : 's have'} no lot size (no Lot Size column, and the expiry
          isn&rsquo;t in Angel One&rsquo;s instrument list), so {lots.missing === 1 ? 'it is' : 'they are'} left out of
          the lots.
        </p>
      )}
    </section>
  );
}
