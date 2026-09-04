import { redactObject } from './redact.mjs';

function serialize(level, message, fields) {
  return JSON.stringify(redactObject({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  }));
}

export function createLogger(base = {}) {
  return {
    child(fields = {}) { return createLogger({ ...base, ...fields }); },
    info(message, fields = {}) { console.log(serialize('info', message, { ...base, ...fields })); },
    warn(message, fields = {}) { console.warn(serialize('warn', message, { ...base, ...fields })); },
    error(message, fields = {}) { console.error(serialize('error', message, { ...base, ...fields })); },
    debug(message, fields = {}) {
      if (process.env.LOG_LEVEL === 'debug') console.log(serialize('debug', message, { ...base, ...fields }));
    },
  };
}
