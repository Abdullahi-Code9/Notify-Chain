interface ExportHistorySkeletonProps {
  rows?: number;
}

function SkeletonCell({ width }: { width: string }) {
  return (
    <span
      className="skeleton-block skeleton-block--inline"
      style={{ width, height: '14px' }}
      aria-hidden="true"
    />
  );
}

export function ExportHistorySkeleton({ rows = 5 }: ExportHistorySkeletonProps) {
  return (
    <div className="export-table-container" aria-busy="true" aria-label="Loading export history">
      <table className="export-table">
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Name</th>
            <th scope="col">Format</th>
            <th scope="col">Created At</th>
            <th scope="col" style={{ textAlign: 'right' }}>
              Records
            </th>
            <th scope="col" style={{ textAlign: 'right' }}>
              Size
            </th>
            <th scope="col">Status</th>
            <th scope="col" style={{ textAlign: 'center' }}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <tr key={rowIndex} className="export-table__row export-table__row--skeleton">
              <td className="export-table__cell-id" data-label="ID">
                <SkeletonCell width="60px" />
              </td>
              <td className="export-table__cell-name" data-label="Name">
                <SkeletonCell width="120px" />
              </td>
              <td data-label="Format">
                <SkeletonCell width="50px" />
              </td>
              <td className="export-table__cell-date" data-label="Created At">
                <SkeletonCell width="110px" />
              </td>
              <td className="export-table__cell-numeric" data-label="Records">
                <SkeletonCell width="50px" />
              </td>
              <td className="export-table__cell-numeric" data-label="Size">
                <SkeletonCell width="60px" />
              </td>
              <td data-label="Status">
                <SkeletonCell width="70px" />
              </td>
              <td className="export-table__cell-action" data-label="Actions">
                <SkeletonCell width="80px" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
