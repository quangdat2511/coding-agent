Add a failing test, then make it pass.

`slugify` in `src/slugify.ts` keeps punctuation: `slugify("Hello, World!")` returns
`"hello,-world!"`. It should return `"hello-world"`.

Work in two steps:

1. Read `src/slugify.ts`, then add `src/slugify.test.ts` with one test that asserts
   `slugify("Hello, World!")` returns `"hello-world"`. Do not change `src/slugify.ts` yet. Reply
   that the failing test is in place.
2. When you are shown the test failing, change `slugify` so that the test passes, and summarize
   what you changed.
