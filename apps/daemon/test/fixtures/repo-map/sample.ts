export function login(user: string, pass: string): boolean { return true; }
class AuthError extends Error {
  private secret = 1;
  public login() {}
  logout() {}
}
interface Foo { bar(): void }
type Bar = { x: number };
