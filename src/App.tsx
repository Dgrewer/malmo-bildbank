// File System Access API (showDirectoryPicker) finns bara i Chromium-baserade
// webbläsare, därför stöds endast Chrome och Edge.
const isSupported = 'showDirectoryPicker' in window

function App() {
  if (!isSupported) {
    return (
      <main className="unsupported">
        <h1>Malmö Bildbank</h1>
        <p>
          Den här webbläsaren stöds inte. Öppna Malmö Bildbank i Google Chrome
          eller Microsoft Edge.
        </p>
      </main>
    )
  }

  return (
    <main>
      <h1>Malmö Bildbank</h1>
    </main>
  )
}

export default App
