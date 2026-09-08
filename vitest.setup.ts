import { setLogLevel } from './apps/admin-app/src/server/logger';

/**
 * Silence the application logger for the whole suite.
 *
 * The tests that matter most here are the ones that drive a failure — a
 * rejected mutation, a dead job, a webhook with a forged signature — and each
 * of them logs at error level by design. Left on, the run's output is a wall of
 * expected errors with the occasional real one hidden in it.
 *
 * Assertions about logging do not go through this: a handler takes its logger
 * as an argument, so a test that cares passes a recording fake.
 */
setLogLevel('silent');
