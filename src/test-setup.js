import '@testing-library/jest-dom'

// jsdom does not implement scrollIntoView — mock it globally so Chat.jsx
// useEffect calls don't throw when the messagesEndRef div is rendered.
window.HTMLElement.prototype.scrollIntoView = function () {}
