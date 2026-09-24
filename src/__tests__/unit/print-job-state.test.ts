import { describe, expect, it } from 'vitest';
import {
    hasUnreturned,
    isReturned,
    nextInstanceNo,
    resolveCurrentInstance,
} from '@/lib/print-job-state';

describe('打印实例的状态推导', () => {
    const printed = (instanceNo: number) => ({ instanceNo, status: 'printed' });
    const returned = (instanceNo: number) => ({ instanceNo, status: 'returned' });

    it('当前有效实例只看已回收的那些', () => {
        // 现场：R1 已做完、已扫回；R2 刚打印、她还没做
        expect(resolveCurrentInstance([returned(1), printed(2)])).toEqual(returned(1));
    });

    it('已回收的有多个时取实例号最大的那一个', () => {
        expect(resolveCurrentInstance([returned(1), returned(3), returned(2)])).toEqual(
            returned(3),
        );
    });

    it('一张都没回收时当前状态为空，不能拿未回收的实例冒充', () => {
        expect(resolveCurrentInstance([printed(1), printed(2)])).toBeNull();
    });

    it('空输入与空数组都应返回 null', () => {
        expect(resolveCurrentInstance([])).toBeNull();
        expect(resolveCurrentInstance(null)).toBeNull();
        expect(resolveCurrentInstance(undefined)).toBeNull();
    });

    it('下一张纸的实例号要把未回收的算进去，否则会撞号', () => {
        expect(nextInstanceNo([printed(1), printed(2)])).toBe(3);
        expect(nextInstanceNo([returned(1)])).toBe(2);
        expect(nextInstanceNo([returned(1), printed(4)])).toBe(5);
    });

    it('没有任何实例时从 R1 开始', () => {
        expect(nextInstanceNo([])).toBe(1);
        expect(nextInstanceNo(null)).toBe(1);
        expect(nextInstanceNo(undefined)).toBe(1);
    });

    it('未回收的纸不影响当前状态，但必须能被发现', () => {
        const jobs = [returned(1), printed(2)];
        expect(resolveCurrentInstance(jobs)?.instanceNo).toBe(1);
        expect(hasUnreturned(jobs)).toBe(true);
    });

    it('全部回收后就没有未回收的纸了', () => {
        expect(hasUnreturned([returned(1), returned(2)])).toBe(false);
        expect(hasUnreturned([])).toBe(false);
        expect(hasUnreturned(null)).toBe(false);
    });

    it('状态判定只认精确的 returned，不做大小写或近似匹配', () => {
        expect(isReturned(returned(1))).toBe(true);
        expect(isReturned(printed(1))).toBe(false);
        expect(isReturned({ instanceNo: 1, status: 'RETURNED' })).toBe(false);
        expect(isReturned({ instanceNo: 1, status: '' })).toBe(false);
    });
});
