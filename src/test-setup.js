import '@testing-library/jest-dom'

// jsdom does not implement scrollIntoView — mock it globally so Chat.jsx
// useEffect calls don't throw when the messagesEndRef div is rendered.
// Guarded so this shared setup is a no-op under node-env suites (server tests).
if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}
