import { transitionState } from './src/core/scheduler/task-instance.js';
const data = JSON.parse(process.argv[process.argv.length-1]);
const [fromState, toState] = data;
const ti = {
  id: 'oracle-test-id',
  taskId: 'oracle-test-task',
  dagRunId: 'oracle-test-run',
  state: fromState,
  tryNumber: 0,
  version: 'oracle-v1',
};
try {
  const result = transitionState(ti, toState);
  process.stdout.write(JSON.stringify({ state: result.state, valid: true }));
} catch (e) {
  process.stdout.write(JSON.stringify({ state: null, valid: false }));
}
