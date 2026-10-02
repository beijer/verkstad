/** A failure the CLI reports as one line on stderr before exiting non-zero. */
export class Failure extends Error {
  code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}
