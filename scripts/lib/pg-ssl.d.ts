/**
 * Types for pg-ssl.js, which is plain CommonJS so that set-superadmin.js and
 * set-superadmin.ts can share one implementation rather than keeping two
 * copies of a security control in step by hand.
 */
export declare function buildPgSslConfig(
  connectionString: string,
  env: Record<string, string | undefined>
): {
  /** The input with every TLS parameter removed, so `ssl` cannot be overridden. */
  connectionString: string;
  ssl: false | { ca: string; rejectUnauthorized: true };
};

export declare const TLS_PARAMS: string[];
