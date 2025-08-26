// Vercel Serverless Function (Node 런타임)
// 엔드포인트: /api/qt/today.json[?qtDate=YYYY-MM-DD]

import cheerio from 'cheerio';

// 날짜별 Duranno URL 후보
const buildUrls = (dateStr) => ([
  `https://www.duranno.com/qt/view/bible.asp?qtDate=${dateStr}`, // 우선 시도
  `https://www.duranno.com/qt/view/bible.asp`                     // 폴백(오늘)
]);

function parseHtml(html) {
  const $ = cheerio.load(html);

  // "오늘의 말씀" 표시가 있는 블록을 루트로 선택
  let sectionRoot = null;
  $('*:contains("오늘의 말씀")').each((_, el) => {
    const t = $(el).text().trim();
    if (t.includes('오늘의 말씀') && !sectionRoot) {
      sectionRoot = $(el).closest('section,article,div');
    }
  });
  if (!sectionRoot || sectionRoot.length === 0) sectionRoot = $('body');

  // 책제목+장절(예: 에스겔 21:1-17) 추출
  const refRegex = /([가-힣A-Za-z.\s]+)\s+(\d+)\s*:\s*(\d+)(?:[-~]\s*\d+)?/;
  let title = null;
  sectionRoot.find('h1,h2,h3,strong,em,p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    const m = t.match(refRegex);
    if (m && !title) title = `${m[1].trim()} ${m[2]}:${m[3]}`;
  });

  // 부제목(짧은 헤드라인)
  let subtitle = null;
  sectionRoot.find('h1,h2,h3,strong,em').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (title && t.includes(title)) return;
    if (t.includes('오늘의 말씀')) return;
    if (t.length <= 60 && !subtitle) subtitle = t;
  });

  // 본문 수집
  let collecting = false;
  const verseParts = [];
  sectionRoot.find('*').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    const t = $(el).text().trim();
    if (t.includes('오늘의 말씀')) { collecting = true; return; }
    if (collecting) {
      if (['h1','h2','h3'].includes(tag) && t.length <= 60) { collecting = false; return; }
      if (['p','li','blockquote'].includes(tag)) {
        const s = t.replace(/\s+/g, ' ').trim();
        if (s && !s.includes('묵상') && !s.includes('요약')) verseParts.push(s);
      }
    }
  });
  if (verseParts.length === 0) {
    sectionRoot.find('p').slice(0, 8).each((_, el) => {
      const s = $(el).text().replace(/\s+/g, ' ').trim();
      if (s) verseParts.push(s);
    });
  }

  return {
    title: title || '본문 참조 미확인',
    subtitle: subtitle || '제목 미확인',
    verse: verseParts.join('\n\n')
  };
}

export default async function handler(req, res) {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC 기준)
    const qtDate = (req.query?.qtDate || todayStr).toString();

    const urls = buildUrls(qtDate);
    let html = null, finalUrl = null, lastErr = null;

    for (const u of urls) {
      try {
        const r = await fetch(u, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
            'Accept-Language': 'ko,en;q=0.9'
          }
        });
        if (r.ok) { html = await r.text(); finalUrl = u; break; }
        lastErr = new Error(`HTTP ${r.status} from ${u}`);
      } catch (e) { lastErr = e; }
    }

    if (!html) throw lastErr || new Error('Duranno 페이지 수신 실패');

    const { title, subtitle, verse } = parseHtml(html);
    if (!verse) throw new Error('본문(오늘의 말씀) 파싱 실패');

    // 캐시(엣지/브라우저): 30분
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    res.status(200).json({ title, subtitle, verse, sourceUrl: finalUrl });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}

// 중요: Edge Runtime(웹표준 런타임) 말고 Node 런타임에서 돌려야 cheerio가 정상 동작함.
// Vercel은 기본이 Node라 별도 지정 불필요. (Edge로 강제 지정하지 마!)
