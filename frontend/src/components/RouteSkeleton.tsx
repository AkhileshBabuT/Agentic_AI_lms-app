export default function RouteSkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading page" style={{ minHeight: '100vh', padding: 'clamp(1rem, 4vw, 3rem)', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ height: 48, width: 'min(280px, 70%)', borderRadius: 8, background: '#e9e5e2', marginBottom: 32 }} />
      <div style={{ height: 32, width: 'min(460px, 90%)', borderRadius: 8, background: '#e9e5e2', marginBottom: 24 }} />
      <div style={{ height: 200, borderRadius: 12, background: '#f1eeeb' }} />
      <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>Loading page</span>
    </main>
  );
}
