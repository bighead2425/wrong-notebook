/** 语文知识点体系
 *
 * 【2026-11-01 重构】用户点出关键问题：语文是**累积型**学科 ——
 * "到高考那天还在考第一天学的东西"（字音、字形、成语、病句，高考前几道题还是这些）。
 * 原来的结构是三个学段各列一套板块（小学"积累与运用"、高中"语言文字运用"），
 * 结果**高中没有"字音""字形"**，一道字音题到了高中就无处可挂。
 *
 * 现在：**三个学段用同一套板块名**（字词 / 句子 / 阅读·现代文 / 阅读·古诗文 / 写作 / 名著与整本书），
 * 考点在各自学段里按深度递进，但**高学段必须能包住低学段的考点**。
 *
 * 覆盖性对照（每一列都要有，否则就是断的）：
 *   字音       小学✓ 初中✓ 高中✓
 *   字形       小学✓ 初中✓ 高中✓
 *   词语/成语   小学✓ 初中✓ 高中✓
 *   病句       小学✓ 初中✓ 高中✓
 *   标点       小学✓ 初中✓ 高中✓
 *   修辞       小学✓ 初中✓ 高中✓（"修辞与表达技巧"）
 *   名著常识    小学—   初中✓ 高中✓   ← "《红楼梦》谁写的"就挂这里
 *   整本书阅读   —      —     高中✓
 *
 * 为什么"名著常识"和"整本书阅读"要分开：
 *   · 名著常识 = 作者/朝代/体裁/情节/人物（客观题，初中高中都考）
 *   · 整本书阅读 = 专题探究/比较阅读/主旨结构（高中新课标，主观题）
 *   合成一个的话，"《红楼梦》谁写的"在高中会挂到"整本书阅读"上，语义就飘了。
 *
 * 取数口径见 `lib/ai/tag-scope.ts` 的 SUBJECT_SCOPE —— 这类学科只给**当前学段**。
 */

export const CHINESE_GRADE_ORDER: Record<string, number> = {
    '小学': 1,
    '初中': 2,
    '高中': 3,
};

export const CHINESE_CURRICULUM: Record<
    string,
    Array<{ chapter: string; sections: Array<{ section: string; tags: string[] }> }>
> = {
    '小学': [
        {
            chapter: '字词', sections: [
                { section: '字音', tags: ['拼音', '声调', '多音字'] },
                { section: '字形', tags: ['笔画笔顺', '形近字', '错别字辨析'] },
                { section: '词语', tags: ['词语理解与搭配', '近义词与反义词', '成语'] },
            ]
        },
        {
            chapter: '句子', sections: [
                { section: '病句', tags: ['修改病句'] },
                { section: '句式', tags: ['句型转换', '扩句与缩句'] },
                { section: '标点符号', tags: ['标点符号'] },
                { section: '修辞', tags: ['比喻与拟人', '排比与夸张'] },
            ]
        },
        {
            chapter: '阅读·现代文', sections: [
                { section: '记叙文', tags: ['记叙文阅读', '概括主要内容', '体会思想感情'] },
                { section: '说明文', tags: ['说明文阅读', '说明方法'] },
                { section: '非连续性文本', tags: ['非连续性文本'] },
            ]
        },
        {
            chapter: '阅读·古诗文', sections: [
                { section: '古诗', tags: ['古诗背诵与理解', '诗意体会'] },
                { section: '文言文', tags: ['浅易文言词句', '文言文翻译'] },
            ]
        },
        {
            chapter: '写作', sections: [
                { section: '记叙类', tags: ['写人记事', '写景状物'] },
                { section: '想象类', tags: ['想象作文'] },
                { section: '修改', tags: ['修改习作'] },
            ]
        },
    ],
    '初中': [
        {
            chapter: '字词', sections: [
                { section: '字音', tags: ['字音', '多音字'] },
                { section: '字形', tags: ['字形', '错别字辨析'] },
                { section: '词语', tags: ['词语运用', '近义词辨析', '成语'] },
            ]
        },
        {
            chapter: '句子', sections: [
                { section: '病句', tags: ['病句辨析与修改'] },
                { section: '标点符号', tags: ['标点符号'] },
                { section: '修辞与句式', tags: ['修辞手法', '仿写与续写', '句式变换'] },
            ]
        },
        {
            chapter: '阅读·现代文', sections: [
                { section: '记叙文', tags: ['记叙文阅读', '人物形象分析', '环境描写作用'] },
                { section: '说明文', tags: ['说明文阅读', '说明方法及其作用'] },
                { section: '议论文', tags: ['议论文阅读', '论点与论据'] },
                { section: '非连续性文本', tags: ['非连续性文本'] },
            ]
        },
        {
            chapter: '阅读·古诗文', sections: [
                { section: '文言文', tags: ['文言实词', '文言虚词', '句子翻译', '内容理解与概括'] },
                { section: '古诗词', tags: ['古诗词鉴赏', '名句默写'] },
            ]
        },
        {
            chapter: '写作', sections: [
                { section: '命题类', tags: ['命题作文', '半命题作文'] },
                { section: '材料类', tags: ['材料作文'] },
                { section: '文体', tags: ['记叙文写作', '议论文写作'] },
            ]
        },
        {
            chapter: '名著与整本书', sections: [
                { section: '名著', tags: ['名著常识', '名著情节与人物'] },
                { section: '综合性学习', tags: ['综合性学习'] },
            ]
        },
    ],
    '高中': [
        {
            chapter: '字词', sections: [
                { section: '字音', tags: ['字音', '多音字'] },
                { section: '字形', tags: ['字形', '错别字辨析'] },
                { section: '词语', tags: ['词语运用', '成语与词语', '近义词辨析'] },
            ]
        },
        {
            chapter: '句子', sections: [
                { section: '病句', tags: ['病句辨析与修改'] },
                { section: '标点符号', tags: ['标点符号'] },
                { section: '语言运用', tags: ['语句衔接', '补写句子', '图文转换'] },
                { section: '修辞与表达技巧', tags: ['修辞与表达技巧', '语言风格赏析'] },
            ]
        },
        {
            chapter: '阅读·现代文', sections: [
                { section: '论述类文本', tags: ['论述类文本'] },
                { section: '实用类文本', tags: ['实用类文本'] },
                { section: '文学类文本', tags: ['文学类文本·小说', '文学类文本·散文'] },
            ]
        },
        {
            chapter: '阅读·古诗文', sections: [
                { section: '文言文', tags: ['文言断句', '古代文化常识', '文言翻译', '内容概括与分析'] },
                { section: '古诗词', tags: ['诗歌鉴赏', '名句默写'] },
            ]
        },
        {
            chapter: '写作', sections: [
                { section: '议论文', tags: ['议论文写作', '材料作文'] },
                { section: '任务驱动型', tags: ['任务驱动型作文'] },
            ]
        },
        {
            chapter: '名著与整本书', sections: [
                { section: '名著', tags: ['名著常识', '名著情节与人物'] },
                { section: '整本书阅读', tags: ['整本书阅读', '专题探究', '比较阅读'] },
            ]
        },
    ],
};
