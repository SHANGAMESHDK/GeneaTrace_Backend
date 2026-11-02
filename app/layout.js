export const metadata = { title: 'GeneaTrace API', description: 'GeneaTrace ledger node' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f6f7f9', color: '#1c1f28' }}>{children}</body>
    </html>
  );
}
