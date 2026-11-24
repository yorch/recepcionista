'use client';

/**
 * Last-resort boundary for errors in the root layout itself (it must render its own <html>/<body>). The i18n provider lives in that
 * layout and is gone here, so the text is shown in both languages (the only place in the app that is not locale-driven).
 */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: '#07090d', color: '#e9eef7', fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
          <div>
            <h1 style={{ fontSize: 24, margin: 0 }}>Something went wrong / Algo salió mal</h1>
            <p role="alert" style={{ color: '#8b98ab', marginTop: 8 }}>Please try again in a moment. / Inténtelo de nuevo en un momento.</p>
            <button
              type="button"
              onClick={() => retry()}
              style={{ marginTop: 16, minHeight: 44, padding: '0 20px', borderRadius: 12, border: 0, background: '#ff6b35', color: '#150800', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
            >
              Try again / Intentar de nuevo
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
