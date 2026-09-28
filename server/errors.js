class AppError extends Error { constructor(status, message, code='REQUEST_FAILED') { super(message); this.status=status; this.code=code; } }
module.exports = { AppError };
