import {
    MATH_CURRICULUM, ENGLISH_CURRICULUM, PHYSICS_CURRICULUM, CHEMISTRY_CURRICULUM,
    BIOLOGY_CURRICULUM, CHINESE_CURRICULUM, HISTORY_CURRICULUM, GEOGRAPHY_CURRICULUM,
    POLITICS_CURRICULUM,
} from '../src/lib/tag-data';
import { writeFileSync } from 'fs';

type Curr = Record<string, Array<{ chapter: string; sections?: Array<{ section: string; tags: string[] }>; tags?: string[] }>>;

/** 按真实提示词里的格式渲染：■ 册 · 章 · 节 / 缩进点名 */
function render(cur: Curr): { text: string; branches: number; points: number } {
    const lines: string[] = [];
    let branches = 0;
    let points = 0;
    for (const [book, chapters] of Object.entries(cur)) {
        for (const ch of chapters) {
            const secs = ch.sections ?? [{ section: ch.chapter, tags: ch.tags ?? [] }];
            for (const s of secs) {
                const head = [book, ch.chapter, s.section].filter(Boolean).join(' · ');
                lines.push(`■ ${head}`);
                lines.push(`    ${s.tags.join(' / ')}`);
                branches += 1;
                points += s.tags.length;
            }
        }
    }
    return { text: lines.join('\n'), branches, points };
}

const out: Record<string, unknown> = {};
const subjects: Array<[string, Curr]> = [
    ['math', MATH_CURRICULUM as unknown as Curr],
    ['english', ENGLISH_CURRICULUM as unknown as Curr],
    ['physics', PHYSICS_CURRICULUM as unknown as Curr],
    ['chemistry', CHEMISTRY_CURRICULUM as unknown as Curr],
    ['biology', BIOLOGY_CURRICULUM as unknown as Curr],
    ['chinese', CHINESE_CURRICULUM as unknown as Curr],
    ['history', HISTORY_CURRICULUM as unknown as Curr],
    ['geography', GEOGRAPHY_CURRICULUM as unknown as Curr],
    ['politics', POLITICS_CURRICULUM as unknown as Curr],
];

let allText = '';
for (const [name, cur] of subjects) {
    const r = render(cur);
    out[name] = { chars: r.text.length, branches: r.branches, points: r.points };
    allText += r.text + '\n';
    writeFileSync(`C:/Users/user/.workbuddy/tmp-eval/list-${name}.txt`, r.text, 'utf8');
}

/* 数学小学 12 册 vs 当前年级段 4 册 */
const mathBooks = Object.keys(MATH_CURRICULUM);
const primary = mathBooks.filter((b) => /^[一二三四五六]年级/.test(b));
const four = primary.filter((b) => ['四年级上', '四年级下', '五年级上', '五年级下'].includes(b));
const sub = (books: string[]) => Object.fromEntries(Object.entries(MATH_CURRICULUM).filter(([k]) => books.includes(k))) as unknown as Curr;

const rAllPrimary = render(sub(primary));
const rFour = render(sub(four));
writeFileSync('C:/Users/user/.workbuddy/tmp-eval/list-math-primary.txt', rAllPrimary.text, 'utf8');
writeFileSync('C:/Users/user/.workbuddy/tmp-eval/list-math-4books.txt', rFour.text, 'utf8');
writeFileSync('C:/Users/user/.workbuddy/tmp-eval/list-all.txt', allText, 'utf8');

out['_math_primary12'] = { chars: rAllPrimary.text.length, branches: rAllPrimary.branches, points: rAllPrimary.points };
out['_math_4books'] = { chars: rFour.text.length, branches: rFour.branches, points: rFour.points };
out['_all_subjects'] = { chars: allText.length };
console.log(JSON.stringify(out, null, 2));
