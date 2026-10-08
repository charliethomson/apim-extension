import Mocha from 'mocha';
import { join } from 'node:path';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 180000, color: true });
  mocha.addFile(join(__dirname, 'extension.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
