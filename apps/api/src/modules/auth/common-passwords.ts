/**
 * A blocklist of the passwords people actually choose.
 *
 * This is a deliberately small, inlined list - the most common leaked passwords plus
 * ones this site invites. A production deployment should check against a real corpus
 * (the Pwned Passwords k-anonymity API, or a local copy of the top million), which is
 * a drop-in replacement for the `has` call in `password.ts`.
 *
 * Entries must be lowercase; `assertPasswordAllowed` lowercases before lookup.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  // Perennial top-20 leaks
  "123456789",
  "1234567890",
  "12345678910",
  "password",
  "password1",
  "password123",
  "password1234",
  "passw0rd123",
  "qwertyuiop",
  "qwerty123",
  "qwerty12345",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "abc123456",
  "iloveyou1",
  "iloveyou123",
  "letmein123",
  "welcome123",
  "welcome1234",
  "admin12345",
  "administrator",
  "monkey123",
  "dragon123",
  "football123",
  "baseball123",
  "sunshine123",
  "princess123",
  "superman123",
  "trustno1234",
  "whatever123",
  "changeme123",
  "secret1234",
  "default123",

  // Keyboard walks long enough to pass a 10-character minimum
  "asdfghjkl;",
  "zxcvbnm123",
  "qazwsxedcrfv",
  "1234qwerasdf",

  // Gambling-flavoured guesses this site invites
  "casino1234",
  "jackpot123",
  "blackjack1",
  "roulette123",
  "pokerface1",
  "luckycharm",
  "luckyseven7",
  "bigwinner1",
  "freechips123",
  "allin12345",
]);
