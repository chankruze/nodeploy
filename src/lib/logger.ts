export function success(message: string): void {
  console.log(`✓ ${message}`);
}

export function fail(message: string): void {
  console.log(`✗ ${message}`);
}

export function warn(message: string): void {
  console.log(`! ${message}`);
}

export function info(message: string): void {
  console.log(message);
}
