// #4918 (#3222 S4): test/runner.test.ts again, with the runner on its key over the worker API instead of the database,
// and the tests there that only that can fail (a lost reply, a reconnect, a wrong key).
process.env.CB_TEST_RUNNER_MODE = 'api';
await import('./runner.test.ts');
