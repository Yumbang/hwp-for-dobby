# 서식(Formatting) 기능 현황 조사 — 2026-08-27

`feat/formatting` 브랜치 준비 조사. 엔진 0.7.19에 대해 **전부 경험적으로 측정**했다.
측정 방법은 이미지 브랜치와 동일하다: 적용 → `exportHwp` → 디스크 기록 → **재로딩 후
디스크에서 읽은 값**으로 판정한다. 반환값이나 메모리 상태는 신뢰하지 않는다(이미지
브랜치에서 같은 실수로 버그 4건이 났다).

재현: `samples/fixture-headings.hwp` 섹션 0, **문단 6**(len=16), 문자 범위 0..10.
표 관련은 `samples/fixture-table.hwp` 문단 0 / 컨트롤 2.

---

## 1. 요약

| | 읽기 | 편집 |
|---|---|---|
| 문자 서식 | **노출 0** (게터는 39키 보유) | 10키 노출 / **33키 실동작** |
| 문단 서식 | **노출 0** (게터는 40키 보유) | 11키 노출 / **33키 실동작** |
| 스타일 | **노출 0** (22개 스타일 목록 보유) | **노출 0** / `applyStyle` 실동작 |
| 번호매기기·불릿 | **노출 0** | **노출 0** / `createNumbering` 실동작 |
| 표 셀 서식 | **노출 0** | **노출 0** / 3개 API 실동작 |
| 용지·구역 레이아웃 | `info.mjs`가 **읽기 전용으로 노출** | **노출 0** / `setPageDef` 실동작 |

**이미지 때와 같은 모양의 문제다.** 읽기가 서식을 전혀 보여주지 않으므로 에이전트는
문서가 현재 어떤 서식인지 모르는 채로 편집한다. 이미지에서는 그 결과가 레이아웃 파괴였다.

---

## 2. 읽기 — 지금 무엇이 나오는가

**`read.mjs` / `sections.mjs` / `extract_tables.mjs`: 서식 정보 0.** 텍스트만 나온다.
`grep -n 'CharProperties\|ParaProperties\|getStyleAt' src/core/read.mjs` → 없음.

**`info.mjs`만 예외적으로 레이아웃을 노출한다** — 이미 쓸 만하다:

```
pages[]: width, height, marginLeft/Right/Top/Bottom, marginHeader/Footer,
         pageBorderLeft/Right/Top/Bottom, columns[{x,width}]
info   : fontsUsed[], fallbackFont, sectionCount, pageCount
```

### 엔진이 주지만 우리가 안 쓰는 게터

| API | 반환 | 비고 |
|---|---|---|
| `getCharPropertiesAt(s,p,off)` | **39키** | 아래 §3 표 |
| `getParaPropertiesAt(s,p)` | **40키** | 아래 §4 표 |
| `getStyleAt(s,p)` | `{id,name}` | 문단의 스타일 |
| `getStyleList()` | 22개 | `바탕글/본문/개요 1..7/…` + `paraShapeId`,`charShapeId` |
| `getStyleDetail(id)` | `{charProps,paraProps}` | 스타일 정의 전체 |
| `getNumberingList()` / `getBulletList()` | 배열 | `levelFormats[7]`, `startNumber` |
| `getSectionDef(s)` / `getColumnDef(s)` / `getPageBorderFill(s)` | 객체 | 구역·단·쪽 테두리 |
| `getCellProperties` / `getCellOwnProperties` | 객체 | 셀 여백·정렬·테두리·`isHeader` |
| `getCellCharPropertiesAt` / `getCellParaPropertiesAt` / `getCellStyleAt` | 본문과 동형 | 셀 안 서식 |
| `getTableProperties(s,p,c)` | 객체 | 표 여백·`repeatHeader`·테두리 |

---

## 3. 문자 서식 편집 — `applyCharFormat`

**33키 실동작.** `format.mjs`가 노출하는 것은 10키.

**동작(현재 노출 10):** `bold` `italic` `underline` `strikethrough` `superscript`
`subscript` `emboss` `engrave` `fontSize` `textColor`

**동작하지만 미노출 (13):** `underlineColor` `strikeColor` `shadeColor`(글자 배경)
`shadowType` `shadowColor` `shadowOffsetX` `shadowOffsetY` `outlineType`
`emphasisDot`(강조점) `underlineShape` `strikeShape` `kerning` `fillType`

**동작하지만 미노출 — 배열/객체형 (9):** `spacings[7]`(자간) `ratios[7]`(장평)
`relativeSizes[7]` `charOffsets[7]` `borderLeft/Right/Top/Bottom` `underlineType`

**동작 안 함 (6):** `fontFamily` `fontFamilies` `charShapeId` `borderFillId`(파생값)
`patternColor` `patternType`

### 우리 문서가 틀렸다 — `lib/format_props.mjs`의 `INEFFECTIVE` 표

이 표는 대부분 **"미지원"이 아니라 "키 이름을 잘못 적은 것"**이었다. 실제 이름으로는 동작한다:

| 표에 적힌 이름 | 판정 | 실제 이름 | 실측 |
|---|---|---|---|
| `charSpacing` | 이름 오류 | **`spacings[7]`** | `[20,…]` → `[20,…]` ✅ |
| `charWidth` | 이름 오류 | **`ratios[7]`** | `[150,…]` → `[150,…]` ✅ |
| `bgColor` | 이름 오류 | **`shadeColor`** | `#123456` ✅ |
| `shadow` | 이름 오류 | **`shadowType`** | `0→1` ✅ |
| `outline` | 이름 오류 | **`outlineType`** | `0→1` ✅ |
| `underlineType` | **판정 오류** | 그대로 동작 | `"Bottom"`/`"Top"` ✅ (`"Solid"`/`"Single"`은 조용히 `None`) |
| `lineSpacingType` | **판정 오류** | 그대로 동작 | `"Fixed"`/`"Percent"` ✅ |
| `fontFamily` | **정확함** | — | 어떤 경로로도 안 됨 (§6) |

→ 현재 `format.mjs`는 **정상 동작하는 `lineSpacingType`·`underlineType`을 exit 2로 거부**한다.

---

## 4. 문단 서식 편집 — `applyParaFormat`

**33키 실동작.** `format.mjs`가 노출하는 것은 11키.

**동작(현재 노출 11):** `alignment` `lineSpacing` `marginLeft` `marginRight` `indent`
`spacingBefore` `spacingAfter` `keepWithNext` `pageBreakBefore` `widowOrphan` `keepLines`

**동작하지만 미노출 (15):** `lineSpacingType` `headType` `paraLevel` `numberingId`
`fontLineHeight` `singleLine` `autoSpaceKrEn` `autoSpaceKrNum` `englishBreakUnit`
`koreanBreakUnit` `tabAutoLeft` `tabAutoRight` `fillType` `borderConnect` `borderIgnoreMargin`

**동작하지만 미노출 — 배열/객체형 (7):** `tabStops[]` `borderLeft/Right/Top/Bottom`
`borderSpacing[4]` `fillColor`(단, `fillType` 동반 필수)

**동작 안 함 (6):** `paraShapeId` `verticalAlign` `defaultTabSpacing` `borderFillId`
`patternColor` `patternType`

---

## 5. 스타일 · 번호매기기 · 셀 · 용지

전부 **실동작하지만 스킬에 전혀 노출되지 않았다.**

| API | 실측 결과 |
|---|---|
| `applyStyle(s,p,styleId)` | ✅ `getStyleAt`→`개요 1`, `paraShapeId 0→2`, `marginLeft 0→13.3pt`. **단 문자 서식은 안 따라온다** |
| `setParaShapeId(s,p,id)` | ✅ `paraShapeId 0→3`, `marginLeft→26.7pt`, `paraLevel→1` |
| `createStyle(json)` | ✅ 새 id 반환, 이름 저장됨. **`charProps`는 무시된다** |
| `createNumbering(json)` | ✅ **단 문단이 `numberingId`로 참조할 때만** 저장된다 (§6) |
| `applyCharFormatInCell(...)` | ✅ 셀 안 `bold` 디스크 확인 |
| `applyParaFormatInCell(...)` | ✅ 셀 안 `alignment` 디스크 확인 |
| `setCellProperties(...)` | ✅ `borderFillId 14→29` |
| `setTableProperties(...)` | ✅ |
| `setPageDef(s,json)` | ✅ 용지 크기·여백·`landscape` 전부 저장 |
| `setSectionDef(s,json)` | ✅ `hideHeader`, `columnSpacing` |
| `setPageBorderFill(s,json)` | ✅ |
| `insertPageBreak(s,p,off)` | ✅ `pageCount 1→2` |

---

## 6. 진짜 불가능한 것 · 함정

### 불가능

1. **글꼴(`fontFamily`) 변경 — 어떤 경로로도 안 된다.** 시도하고 전부 실패한 경로:
   - `applyCharFormat({fontFamily})` → `ok:true`, 디스크 변화 없음
   - `findOrCreateFontId("굴림")` (id 2 반환 = 등록은 성공) 후 재시도 → 여전히 변화 없음
   - `createStyle({charProps:{fontFamily}})` + `applyStyle` → 스타일은 붙지만 글꼴은 그대로
   - `setCharShapeId(s,p,st,en,id)` → id 1·2·3 전부 `ok:true`에 **완전 무동작**
   - `applyCharFormat({fontFamilies:[7개]})` → 무동작
   `format_props.mjs`의 `fontFamily` 항목은 정확했다. **글꼴은 못 바꾼다.**

2. **`setColumnDef` — 단 개수가 안 바뀐다.** 인자 순서 3가지 + JSON 페이로드까지
   시도했으나 `columnCount`는 항상 1. `spacing`만 바뀐다. 다단 편집은 불가.

3. **`updateStyleShapes(0,1,1)` → WASM `memory access out of bounds`.**
   throw 후 문서 객체는 살아있고 export도 되지만, **호출하면 안 된다.**

4. `ensureDefaultBullet` → id 반환하지만 `getBulletList()`는 계속 `[]`.

### 함정 (전부 `ok:true`를 반환한다)

| 함정 | 실측 |
|---|---|
| **빈 문단에 문자 서식** | 문단 5(len=0)에 `(0,5,0,5)`·`(0,5,0,0)`·`(0,5,0,1)` 전부 `ok:true` + **무동작**. 서식만 먼저 잡아두려는 시도가 조용히 사라진다 |
| **`lineSpacing` 단위가 `lineSpacingType`에 종속** | `Percent`면 퍼센트, `Fixed`면 HWPUNIT (`2400`→`16pt`). 현재 문서는 "percent"라고만 적혀 있다 |
| **`fillColor`는 단독으로 무동작** | `{fillColor}` 단독 → 무시. `{fillColor, fillType:"solid"}` → 적용 |
| **`shadowOffsetX/Y`는 signed byte** | `128`→`-128`, `200`→`-56`, `2000`→`-48`. 범위 검사 필요 |
| **`tabStops` 키가 비대칭** | 넣을 때 `fillType`, 읽을 때 `fill` |
| **`createNumbering`은 참조돼야 살아남는다** | 생성만 하면 저장 시 사라짐. `applyParaFormat({numberingId, headType:"Number"})`로 참조하면 디스크에 남음 ✅ |
| 없는 문단 번호 | **throw** (`문단 999 범위 초과`) — 이건 조용하지 않다. exit 3으로 매핑하면 된다 |
| 범위 초과 문자 offset | `(0,6,0,999)`는 클램프되어 정상 동작 |

### SKILL.md 정정 필요

65행 **"style systems — not supported on this engine build (documented gap)"** → **거짓**.
`applyStyle`·`createStyle`·`setParaShapeId`는 동작한다.

---

## 7. 실문서 124건 측정 — 우선순위 근거

`~/Downloads` 124건(1건 로드 실패), 문단 6,918개 표본. **집계값만 기록하며 파일명은 남기지 않는다.**

| 항목 | 빈도 | 판단 |
|---|---|---|
| 문서당 글꼴 2종 이상 | **124/124 (100%)** | 글꼴이 가장 흔한데 **우리가 못 바꾸는 유일한 것** |
| 본문 여백이 기본값이 아님 | **106/124 (85%)** | `setPageDef` 노출 가치 높음 |
| **내어쓰기(음수 indent)** | **69/124 (56%)** | 개조식의 핵심. 이미 지원 중 ✅ |
| 굵게 사용 | 81/124 (65%) | 지원 중 ✅ |
| 본문 글자 크기 2종 이상 | 70/124 (56%) | 지원 중 ✅ |
| `바탕글` 외 스타일 사용 | **66/124 (53%)** | `applyStyle` 노출 가치 높음 |
| `headType` 분포 | **Bullet 442** / Number 7 / Outline 7 | 불릿 개조식이 압도적 |
| 왼쪽 여백 > 0 | 30/124 (24%) | 지원 중 ✅ |
| 탭 정지 사용 | 24/124 (19%) | 미노출 |
| 색 글자 | 28/124 (23%) | 지원 중 ✅ |
| `numberingId` > 0 | 16/124 (13%) | 미노출 |
| 밑줄 | 12/124 (10%) | 지원 중 ✅ |
| 다구역 | 13/124 (10%) | — |
| **문단 테두리 / 문단 배경** | **1/124 (1%)** | 후순위 |
| **가로 용지** | **1/124 (1%)** | 후순위 |

정렬 분포: `justify` 5542 / `center` 700 / `left` 354 / `right` 322.
`lineSpacingType`: **6,918개 문단 전부 `Percent`** — `Fixed`는 실문서에 없다.

---

## 8. 조사에서 나온 할 일 (구현 아님, 목록만)

1. `format_props.mjs`의 `INEFFECTIVE` 표 정정 — 7개 중 6개가 틀렸다. 정상 키를 막고 있다.
2. SKILL.md 65행 "style systems not supported" 정정.
3. 읽기 쪽 서식 노출 — 이미지와 같은 순서(**읽기 먼저, 편집을 거기 맞춤**).
4. 빈 문단 무동작 함정: `format.mjs`가 사전에 `getParagraphLength`로 막아야 한다.
5. `lineSpacing` 단위 종속성 문서화.
6. 글꼴 변경 불가를 **명시적 실패**로 만들기(현재도 exit 2로 막고는 있음).
7. 신규 spec 규칙 59~ 및 대응 테스트.

측정 스크립트는 세션 스크래치패드에 있고 커밋하지 않았다. 재현 방법은 이 문서 상단에 있다.

---

## 9. 읽기 표현 설계를 위한 추가 측정 (2026-08-27)

### 지금 출력 형식

| 스크립트 | 형식 | 티어 |
|---|---|---|
| `read.mjs` | `text` \| `json` — **markdown 없음** | core |
| `sections.mjs` | `text` \| `json` | core |
| `extract_tables.mjs` | `json` \| `markdown` \| `csv` | core |
| `enhanced/read_precise.mjs` | `text` \| `markdown` | **enhanced (Claude Code 전용)** |

본문은 plain text다. 즉 markdown의 `**bold**` 같은 **자연스러운 삽입 자리가 없다.**
다만 이미지가 이미 인라인 마커 관례를 만들어 두었다: `[image 56% of text width · beside]`.

### 서식 어휘(vocabulary) 크기와 집중도 — 74개 문서

| 항목 | 값 |
|---|---|
| 문서당 문단 수 | median **57** |
| distinct `paraShapeId` | median **9**, mean 17.7, max 162 |
| distinct `charShapeId` | median **7**, mean 9.0, max 50 |
| 최빈 paraShape 점유율 | median **42%**, mean 45% |
| 최빈 charShape 점유율 | median **45%** |
| paraShape ≤ 10개인 문서 | 45/74 (61%) |
| 최빈 shape가 90% 이상 덮는 문서 | **3/74 (4%)** |

**이 수치가 "기본값 + 예외" 모델을 기각한다.** 지배적 기본값이 없다(42%). 예외로
보고할 대상이 문단의 58%가 되어 압축이 안 된다.

**반대로 팔레트 모델은 성립한다.** 57문단 문서의 어휘가 9개다 —
정의 9개 + 문단당 id 참조 하나로 완전하게 표현된다.

### 문단 내부 변화 (run) — 60개 문서 / 1,795문단

| 항목 | 값 |
|---|---|
| 문단 전체가 균일 (run 1개) | **1,401 / 1,795 (78%)** |
| 문단 중간에 서식 변화 | 394 (22%) |
| 그런 문단을 가진 문서 | 35/60 (58%) |
| run 분포 | 1:1401, 2:197, 3:97, 4:24, 5:21, 6+:55 |

→ run 단위 보고는 **필요하지만 예외 경로**다. 기본은 문단 단위로 충분하다.

### 팔레트 스캔 비용 — 무시 가능

| 문서 | 문단 | 스캔 |
|---|---|---|
| 199.0MB | 106 | **3ms** (28 paraShapes / 9 charShapes) |
| 94.3MB | 69 | 1ms |
| 84.5MB | 7 | 0ms |

`getPageControlLayout`(51ms) 같은 지연 로딩 고민이 필요 없는 수준이다.

### 결론

문제는 **어디에 둘 것인가**가 아니라 **양이 왜 많은가**였다. 문단마다 속성을 다 찍으니
많은 것이고, 팔레트로 표현하면 애초에 많지 않다. 사이드카 파일은 증상(출력이 큼)을
옮길 뿐 원인(표현이 중복적)을 없애지 못한다 — 게다가 에이전트는 결국 그 파일을
컨텍스트로 읽어야 한다.

본문과 분리한다는 방향은 옳다. 다만 **파일이 아니라 별도 op**로 분리하면 된다.
`image.mjs --op list`가 이미 같은 문제를 같은 방식으로 풀었다(본문에는 짧은 마커,
상세는 전용 op). 서식도 같은 2채널로 간다.

---

## 10. 팔레트를 "독자규격"으로 만들지 않으려면 (2026-08-27)

제기된 두 우려를 측정으로 검증했다. **둘 다 실재하고, 두 번째는 예상보다 크다.**

### 10-1. shape id는 왕복해도 번호가 유지된다

편집 없이 `exportHwp` → 재로딩 후 문단별 `(paraShapeId, charShapeId)` 비교:

| | |
|---|---|
| 동일 | **23/24 문서** |
| 재번호(renumber) 발생 | **0** |
| 예외 1건 | id 변화가 아니라 **문단 수 26 → 27** (아래 별건) |

→ 엔진의 shape id는 안정적이다. 우리가 새 식별자를 발명할 이유가 없다.

**별건 버그 후보:** 무편집 왕복에서 문단이 하나 늘어나는 문서가 1건 있었다
(26→27, 섹션 수는 2로 동일). 서식과 무관하지만 기록해 둔다.

### 10-2. 그러나 읽기/쓰기 비대칭이 있다 — 여기가 진짜 함정

| 핸들 | 읽기 | 쓰기 | 안정성 |
|---|---|---|---|
| `paraShapeId` | ✅ | ✅ **`setParaShapeId`** | ✅ |
| `charShapeId` | ✅ | ❌ **`setCharShapeId`는 전 id에서 무동작** | ✅ |

→ **문자 팔레트 id를 주소로 노출하면 그게 정확히 "독자규격" 함정이다.**
읽을 수만 있고 되돌려 쓸 수 없는 식별자가 된다.

### 10-3. 설계 원칙 — 팔레트는 스키마가 아니라 보고서 압축이다

팔레트 항목을 **`format.mjs --props`가 그대로 받는 어휘로** 기술한다.
`alignment: "center", indent: -2000` 처럼. 그러면:

- 에이전트가 읽은 것을 **번역 없이** 그대로 쓰기에 넣을 수 있다
- 그룹 라벨(`P1`)은 **그 보고서 안에서만 유효한 지역 이름**이며 문서에 저장되지 않는다
- 새 어휘가 0개다 — 이미 있는 prop 이름만 쓴다

즉 팔레트는 **중복 제거**지 새 포맷이 아니다. 스냅샷/diff의 `renderVersion`
문제도 생기지 않는다(값 자체는 엔진 값 그대로이므로).

### 10-4. 문단 내 글꼴 변화 — 두 개의 서로 다른 문제였다

**(a) 진짜 run 경계** — 1,795문단 중 395개(22%)에서 문단 중간에 서식이 바뀐다.
어떤 속성이 바뀌는지(run 경계 수):

| 속성 | 경계 수 |
|---|---|
| `bold` | **293** |
| **`fontFamily`** | **172** |
| `fontSize` | 144 |
| `italic` | 80 |
| `underline` | 78 |
| `superscript` | 52 |
| `textColor` | 20 |
| `subscript` | 12 |

→ 글꼴이 문단 중간에 바뀌는 건 실제로 흔하다. 가정으로 배제하면 안 된다.

**(b) 더 큰 문제 — char shape 하나가 글꼴 7개를 갖는다.**
`fontFamilies[7]` = 한글 / 라틴 / 한자 / 일어 / 기타 / 기호 / 사용자.

| | |
|---|---|
| 검사한 char shape | 2,770 |
| **7개 슬롯이 전부 같지는 않은 shape** | **1,139 (41%)** |

→ **run이 하나도 없어도** "이 문단의 글꼴은 함초롬바탕"은 41%에서 거짓이다.
한글 본문에 영문 용어가 섞이면 run 경계 없이 글꼴이 갈린다. 단일 값으로
보고하는 설계는 여기서 조용히 틀린다.

### 10-5. 스타일 이름으로 대체할 수는 없다

HWP 자체 어휘인 스타일(`바탕글`/`본문`/`개요 1`)을 쓰면 발명이 없지만, 커버리지가 부족하다:

| | median |
|---|---|
| 문서가 실제 사용하는 스타일 수 | **2** |
| distinct `paraShapeId` | **5** |
| shapes > styles 인 문서 | **51/60 (85%)** |

→ 스타일은 85% 문서에서 서식 다양성을 **과소 기술**한다. 보조 라벨로는 쓸 수 있으나
표현의 기반으로는 못 쓴다.

### 10-6. 정직성 요구사항

글꼴은 **읽을 수 있지만 바꿀 수 없다**(§6). 팔레트가 글꼴을 보여주면서 그 사실을
말하지 않으면, 에이전트는 당연히 바꾸려 시도하고 exit 2를 맞는다.
→ 출력에 **읽기 전용 표시가 필요하다.**
