import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { loadModel } from '../utils';

const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

describe('Trigger.dev Schema Tests', () => {
    it('model loading', async () => {
        const content = fs.readFileSync(path.join(_dirname, './trigger-dev.zmodel'), {
            encoding: 'utf-8',
        });
        await loadModel(content);
    });
});
