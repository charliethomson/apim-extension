import * as vscode from 'vscode';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

let logger: Logger | undefined;

/** The extension's output channel ("APIM Policy"). With APIM_DEBUG set, also logs to the console. */
export function log(): Logger {
  if (logger) return logger;
  const channel = vscode.window.createOutputChannel('APIM Policy', { log: true });
  const mirror = !!process.env.APIM_DEBUG;
  const wrap = (level: keyof Logger) => (msg: string) => {
    channel[level](msg);
    if (mirror) console.log(`[apim:${level}] ${msg}`);
  };
  logger = { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
  return logger;
}
