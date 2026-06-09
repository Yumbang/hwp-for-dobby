# rhwp-behavior.md — `hwp` 스킬 동작 명세 (Behavioral Spec)

> **KEYSTONE 문서.** 이 파일은 `hwp` Claude 스킬이 감싸는 rhwp 엔진(`@rhwp/core`)의 **실제 동작**에 대한 단일 진실 공급원(single source of truth)입니다. 각 규칙은 `hwp/test/spec/` 아래 테스트 하나로 매핑됩니다(끝의 Catalog→Rule 추적표 참조). 스킬은 어떤 경우에도 사용자 문서를 **조용히 손상시켜서는 안 됩니다(MUST NOT silently corrupt)** — 그래서 "조용한 실패(silently dropped)" 케이스는 전부 여기에 명시되고 테스트로 고정됩니다.

## 버전 고정 (Version Pin)

- **대상 엔진:** rhwp `@rhwp/core` **0.7.15** (vendored: `hwp/vendor/rhwp/VERSION` = `0.7.15`).
- 0.7.10~0.7.11 시절 문서의 버전 민감 주장(예: HWPX XML 엔티티 드롭)은 **이 버전에서 재검증**되어 정정되었습니다. 본 명세는 0.7.15에서 경험적으로 확인된 동작만 기술합니다.
- 검증 도구:
  - 캐노니컬 로더: `hwp/src/lib/_bootstrap.mjs` — `loadDocument(path)`, `emptyDocument()`(Promise — `await` 필요), `version()`, `atomicWriteFile`, `assertHwpOutput`.
  - 검증 헬퍼: `hwp/src/lib/verify.mjs` — `exportVerify(doc, outPath, {expectPresent,expectAbsent})`, `probeTextCount(doc, q, caseSensitive)`.
  - API 표면: `hwp/vendor/rhwp/rhwp.d.ts`.
- 픽스처(자립형): `hwp/samples/fixture-table.hwp`(진짜 .hwp, 셀 `△1,802`, 표 `(0,4,0)` = 9×8/cellCount 68), `hwp/samples/fixture-table.hwpx`(셀 `65,063,026,600`, 표 `(0,0,2)` = 3×8/cellCount 18), `hwp/samples/fixture-form.hwp`(clickhere 필드 `myMsg01`, 빈 값).

## 검증 등급 (Verdict legend)

- **CONFIRMED** — 0.7.15에서 스크립트 프로브로 직접 재현됨.
- **CONFIRMED (source/CHANGELOG)** — 소스/CHANGELOG로 확인(런타임 프로브 불가하거나 불필요).
- **UNTESTABLE-BLACKBOX** — WASM API로 노출되지 않아 런타임 단정 불가; 에이전트측 로직 또는 소스 추론.
- **SPEC-FIRST** — 아직 스킬에 구현되지 않은 동작을 규정(테스트가 요구 사양을 정의). 기존 동작 기술이 아님.

---

## 1. Tables (표 읽기/구조)

1. **머지 원점 저장(merge-origin storage).** 병합된 셀의 텍스트는 병합 범위의 **원점(top-left) 셀에만 한 번** 저장되며, 덮인(covered) 위치에는 셀이 존재하지 않는다. 스킬은 **반드시 `getCellInfo`가 반환하는 `{row, col, rowSpan, colSpan}`로 주소 기반 그리드를 재구성**해야 하며(주의: `cellAddr`라는 필드는 **없다**), 문서(컨트롤) 순서로 셀을 읽으면 병합 데이터가 조용히 어긋난다. — **CONFIRMED.** `test:` `fixture-table.hwpx`의 `getCellInfo(0,0,2,0)`가 `{"row":0,"col":0,"rowSpan":1,"colSpan":4}`를 반환하고, 그리드 재구성 시 덮인 위치가 원점 셀에서 채워지는지 단정.
2. **`cellCount`는 원점 셀만 센다.** `getTableDimensions.cellCount`는 **원점 셀 수**이며 `rowCount*colCount`가 아니다. 병합이 있으면 `cellCount < rowCount*colCount`. 셀 반복 루프 상한으로 `cellCount`를 쓰고, 전체 그리드는 span으로 복원한다. — **CONFIRMED.** `test:` `fixture-table.hwpx`에서 `getTableDimensions(0,0,2)` = `{rowCount:3,colCount:8,cellCount:18}` → `18 < 24` 단정.
3. **중첩 표(nested tables)는 셀 문단 내부에 존재.** 평탄(flat) 문단 레벨이 아니라 **각 원점 셀의 문단**을 순회하며 `*ByPath` API로 컨트롤을 프로브해야 발견된다(`getCellParagraphCount` + `getTableDimensionsByPath(cellPath)`). 부모→자식 깊이 우선. **셀 문단당 컨트롤 인덱스 7을 넘는 표는 누락**된다(`NESTED_PROBE_MAX=8` 하드코딩). — **CONFIRMED (source+probe).** `test:` 중첩 표가 부모 셀 메타로 발견되고, 8번째 이후 컨트롤은 미탐지임을 단정(중첩 샘플 부재 시 probe-limit 단위 테스트로 대체).
4. **범례/작성요령 표 필터링은 에이전트측.** 데이터 표 뒤에 구분자 없이 범례/작성요령 표가 붙는다. 엔진은 구분하지 않으므로 **헤더 행 키워드**로 분류한다: 첫 행에 `연번`/`학위과정`/`성명`/`발표형식` → 데이터; `구분`/`교육연구단 학문분야`이고 `연번` 없음 → 범례(데이터 추출 시 드롭 권장). — **SPEC-FIRST (agent-side, `extract_tables`에 `--data-tables-only` 미구현).** `test:` 헤더 키워드 분류 함수의 단위 테스트(고정 헤더 입력 → 분류 라벨).
5. **마커형 vs 라벨형 폼.** 폼 상세 컬럼은 두 패턴 중 하나: **(a) 마커형** — 각 줄이 원문자 `①~⑩`로 시작(마커로 split, 나머지가 값, 마커 없는 줄은 직전 키에 누적); **(b) 라벨형** — `라벨: 값`/`라벨：값`(한/전각 콜론). 각 필드는 **표의 별도 ROW(rowSpan)**에 있으며 멀티라인 셀이 아니다. 엔진은 구분하지 않는다. — **SPEC-FIRST (agent-side 파싱 미구현).** `test:` 두 패턴 고정 입력 → 키/값 파싱 단위 테스트.
6. **플레이스홀더 정규화는 에이전트측.** `'-'`, `'X'`, `';N'`, `'N'`, `'번호'`, `'해당없음'`, `'N/A'`, `'DOI 번호'`, 괄호 변형 등은 빈 문자열로 정규화한다. rhwp는 플레이스홀더와 데이터를 구분하지 않는다. — **SPEC-FIRST (agent-side, `--drop-empty` 미구현).** `test:` 정규화 함수 입력/출력 매핑 단위 테스트.
7. **풀-와이드 공백은 U+2007(figure-space).** 표/수치 텍스트의 전각 공백은 **U+2007**(figure-space)로 추출되며 U+3000(ideographic-space)이 아니다. 필드 공백 검색/매칭은 **U+2007 기준**(또는 `\s`)으로 해야 한다. — **CONFIRMED.** `test:` HWPX 샘플 추출 텍스트에 U+2007 존재, U+3000 부재 단정.
8. **`getPageTextLayout`은 근사 레이아웃.** `{text,x,y,w,h,charX[],fontFamily,fontSize,...}` 런 배열을 y 기준 정렬로 반환하며, 같은 줄의 런은 **y±(런 높이/2)** 오차로 묶인다. 컬럼/행 구조 추론용이며 **픽셀 정확 위치가 아니다**(정밀 렌더는 `enhanced/` CLI render/export-png). — **CONFIRMED.** `test:` `fixture-table.hwp` page 0에서 런을 `floor(y)`로 그룹화해 줄 묶음이 안정적인지 단정.

---

## 2. Editing / Round-trip (편집 및 저장 왕복)

> **핵심 원리(raw_stream 캐시 버그).** 진짜 .hwp는 원본 `section.raw_stream` 바이트를 캐시한다. 직렬화기는 캐시된 raw_stream이 있으면 **IR 변경을 무시하고 캐시 바이트를 그대로 방출**한다. 따라서 **`raw_stream`을 null로 비우는 API만** .hwp 왕복에서 안전하다. HWPX 입력은 raw_stream이 없어 모든 편집이 IR에서 재구성된다.
>
> **검증 메커니즘 주의:** `verify.mjs`의 `probeTextCount`는 `replaceAll(q, q)`(자기 자신으로 치환하는 no-op)의 **match COUNT만** 사용한다 — 내용이 바뀌지 않으므로 raw_stream 드롭과 무관하게 카운트가 정확하며, 본문+셀+텍스트박스 **전체 문서**를 커버한다(`searchText`는 본문만). 모든 왕복 단정은 이 카운트에 의존한다. 즉 `probeTextCount`로 "있다/없다"를 보는 것은 안전하나, 이것이 `replaceAll`로 **내용을 바꾸는 것**이 .hwp에서 동작한다는 뜻은 **아니다**(규칙 9).

9. **`replaceAll()`은 진짜 .hwp에서 안전하지 않다 — 조용히 드롭된다.** `replaceAll(query, replacement, caseSensitive)`는 IR을 변경하지만 `section.raw_stream`을 null로 비우지 **않아**, 저장 시 편집이 **에러 없이 사라진다(FAILS-SILENTLY)**. **본문·셀 동일하게 영향**. 스킬은 진짜 .hwp에서 `replaceAll`을 **쓰면 안 된다**. — **CONFIRMED (0.7.15에서도 미수정).** `test:` `fixture-table.hwp`에 `replaceAll('△','REPLACED_HWP',true)` → in-memory count=31, export→reload 후 `'△'` 여전히 31, `'REPLACED_HWP'` 0 단정.
10. **`replaceText()`(위치 기반)는 안전하다.** `replaceText(section, para, char_offset, length, new_text)`는 검색이 아닌 **위치 기반 치환**이며 raw_stream을 null로 비워 **.hwp 왕복 생존**. `replaceAll`과 다르다. — **CONFIRMED.** `test:` `searchText('△')`로 위치 찾고 `replaceText(0,23,3,1,'REPLACED_POS')` → reload 시 치환 텍스트 count=1 단정.
11. **안전 편집 경로(safe path) = 검색 후 insert/delete.** .hwp 찾기/바꾸기는 **(1) `searchText` 순회로 위치 수집(역순) → (2) `deleteText`/`deleteTextInCell`로 제거 → (3) `insertText`/`insertTextInCell`로 삽입**. `insertText`/`deleteText` 계열은 raw_stream을 null로 비워 편집이 생존한다. `replaceAll`은 절대 쓰지 않는다(HWPX 입력 제외, 규칙 26). — **CONFIRMED.** `test:` 검색→삭제→삽입 시퀀스가 reload에서 일관됨을 단정.
12. **`insertText`(본문)는 .hwp와 .hwpx 입력 모두에서 생존.** `insertText(section, para, char_offset, text)` 반환 `{ok:true, charOffset:N}`. — **CONFIRMED.** `test:` .hwp/.hwpx 각각 삽입 후 reload count=1 단정.
13. **`deleteText`(본문)는 .hwp에서 생존.** `deleteText(section, para, char_offset, count)`는 offset에서 정확히 `count`자 삭제, raw_stream null. — **CONFIRMED.** `test:` 삽입 후 `deleteText`로 제거 → reload count=0 단정.
14. **`insertTextInCell`은 .hwp와 .hwpx 입력 모두에서 생존.** 시그니처 `insertTextInCell(section, parent_para, control_idx, cell_idx, cell_para_idx, char_offset, text)`. (.hwp 픽스처 표 = `(0,4,0)`; .hwpx = `(0,0,2)` — 위치는 다르나 둘 다 동작.) `deleteTextInCell`도 동일하게 생존. — **CONFIRMED.** `test:` 두 입력에서 셀 삽입 후 reload count=1, 삭제 후 count=0 단정.
15. **out-of-bounds 셀 인덱스는 하드 실패(throw).** `cell_idx >= cellCount`로 `insertTextInCell` 호출 시 **WASM 엔진이 throw**한다. 단, 잡을 수 있는 Error 메시지가 아니라 **반환값이 `undefined`**가 되어 `JSON.parse` 실패로 나타난다(Rust panic 표면화). 경계는 `rowCount*colCount`가 **아니라 `cellCount`**다 — 예: `(0,4,0)` 표는 9×8이지만 4개 병합으로 `cellCount=68`이며, `cell_idx=71`(<72)도 throw한다. 스킬은 호출 전 `cell_idx ∈ [0, cellCount)`로 **사전 검증**해야 한다. — **CONFIRMED.** `test:` `cellCount=68`인 표에 `insertTextInCell(...,cellIdx=71,...)` 반환이 `undefined`(JSON.parse 실패)임을 단정.
16. **`insertTextLogical`은 컨트롤을 논리 단위 1로 센다.** `insertTextLogical(section, para, logical_offset, text)` 반환 `{ok:true, logicalOffset:N}`이며 **`N = insert_offset + text.length`**(위치 상대값 — 고정값 아님). 인라인 표 등 컨트롤은 **단일 논리 오프셋**으로 계산되어 텍스트 삽입 시 컨트롤 수가 증식하지 않는다. — **CONFIRMED.** `test:` `insertTextLogical(0,0,5,'[INS]')`(6자) → `logicalOffset === 11` 및 문단 컨트롤 수 불변 단정.

---

## 3. Forms (폼 필드)

17. **빈 폼 필드 값은 왕복 생존.** `setFieldValueByName(name, value)`는 IR 업데이트 경로(raw_stream fast-path 아님)로 라우팅되어 .hwp export/reload에서 값이 보존된다. — **CONFIRMED.** `test:` `fixture-form.hwp`의 `setFieldValueByName('myMsg01','PERSIST_TEST_0715')` → reload 시 값 일치 단정.
18. **필드 사전 채움 감지.** 채우기 전 `getFieldValue(fieldId)`(또는 `getFieldList`의 `value`)가 비어 있지 않으면 **사전 채워진 필드**다 — 이때 규칙 19 위험을 경고해야 한다. — **CONFIRMED.** `test:` `getFieldList` value로 빈/채움 판별 단정.
19. **#838 위험: 채워진 필드 글자 모양(char-shape) 비보존 → Hancom 거부 가능.** `setFieldValueByName`이 **사전 채워진** 필드의 텍스트는 덮어쓰되 char-shape/line-seg 메타를 시프트하지 않아 한컴이 거부할 수 있다. **빈 필드 채우기는 깨끗하다**(권장). vendored CHANGELOG(0.7.10까지)에 수정 기록 없음 → **여전히 열린 위험으로 취급**. 결과 등급 = WORKS+WARN. — **UNTESTABLE-BLACKBOX (한컴 거부는 외부 판정).** `test:` 빈 필드 채우기 왕복은 PASS 단정; 사전 채워진 필드 편집은 WARN 출력 여부를 단정(회귀 감시).

---

## 4. Parsing / Environment (파싱 및 환경)

20. **HWPX XML 엔티티 보존(0.7.15에서 정상).** `&amp;`/`&lt;`/`&gt;`는 로드 시 리터럴 `&`/`<`/`>`로 정확히 디코드된다. **0.7.15에서 특수 처리 불필요.** (구 스킬 문서는 0.7.10~0.7.11 드롭→0.7.12 수정이라 기록하나, vendored CHANGELOG에 0.7.11~0.7.15 항목이 없어 그 버전 연혁은 **확인 불가**; 0.7.15 정상은 경험적으로 확인됨.) — **CONFIRMED (0.7.15 probe).** `test:` `R&D` 등 `&`/`<`/`>` 포함 텍스트 왕복 후 `getTextRange`가 동일 문자를 반환함을 단정.
21. **macOS NFD vs 코드 NFC 정규화.** 한글은 NFD(분해)와 NFC(결합) 길이가 다르다(`'한글'.normalize('NFC').length=2` vs `'한글'.normalize('NFD').length=6`). 한글 glob 패턴은 매칭이 어긋날 수 있으므로 **디렉터리 스캔 + `normalize('NFC')`** 비교를 쓰고, CLI는 한글 glob이 아닌 **명시적 파일 경로**를 받는다. — **CONFIRMED.** `test:` NFC/NFD 길이 차이 + 정규화 후 매칭 단위 테스트.
22. **PUA 글리프(U+E000–F8FF)는 보존되나 tofu 렌더.** PUA 코드포인트는 IR/직렬화에서 **무손실 보존**(`insertText`/`getTextRange` 왕복)되지만, 표준 폰트에 글리프가 없어 **두부(tofu) 박스**로 렌더된다. 추출 시 특별 처리 불필요; 시각 출력은 신뢰하지 말 것. — **CONFIRMED.** `test:` `'Test'+U+E000+'PUA'` 왕복 후 PUA 문자 보존 단정.

---

## 5. Serialization / Hancom (직렬화 및 한컴 호환)

23. **출력은 항상 .hwp — HWPX 출력 금지.** 스킬은 `exportHwp()`만 호출하며 .hwpx로 저장하지 않는다. `exportHwpx()`는 존재하고 유효한 ZIP+XML 바이트를 내지만 **한컴 2020+가 입력으로 거부(파일 손상)**한다. `_bootstrap.mjs`의 `assertHwpOutput()`이 .hwpx 출력 경로를 차단한다. HWPX **입력**은 어댑터로 .hwp 변환되어 안전. — **CONFIRMED (코드+API).** `test:` `assertHwpOutput('x.hwpx')`가 거부(exit 2)하고, 스킬 export 경로가 .hwp만 방출함을 단정.
24. **HWPX 입력 → .hwp 출력 왕복에서 `replaceAll`도 생존.** HWPX 입력은 raw_stream 캐시가 없어 직렬화기가 IR을 walk → `exportHwp()`가 IR로부터 .hwp를 머티리얼라이즈. 따라서 HWPX 입력 위에서는 `replaceAll`(본문/셀)도 왕복 생존한다. — **CONFIRMED.** `test:` `fixture-table.hwpx`에 `replaceAll('65,063,026,600','REPLACED_HWPX',true)` → reload 시 치환 present, 원본 absent 단정.
25. **빈 문서로부터 신규 생성(create-from-scratch) 동작.** `await emptyDocument()` → `insertText(...)` → `exportHwp()` → reload에서 텍스트 생존, 유효 .hwp 바이트 생성. (주의: `emptyDocument()`는 **Promise** — `await` 필수.) — **CONFIRMED.** `test:` 빈 문서에 `'SCRATCH_DOC_0715'` 삽입 후 export→reload count=1, 바이트>0 단정.
26. **셀 패딩 클램프 가드(파일 손상 방지).** `pad_top + pad_bottom > cell.height`이면 직렬화기가 양쪽을 **셀 높이의 50%까지 비례 축소**(`resolve_cell_padding`, Task #501). 에이전트가 관리할 필요 없이 엔진이 처리. — **CONFIRMED (CHANGELOG, `[0.7.9]` 릴리스 / v0.7.8 후속 사이클, line 89–92; 0.7.10·0.7.15 포함).** `test:` 과대 패딩 셀 문서 export 후 reload가 손상 없이 열림을 단정(회귀 감시).
27. **`control_mask` 재계산(오펀 문단 가드)은 직렬화기 내부.** 셀 분할 시 "파일 손상" 방지를 위한 `control_mask` 재계산은 **WASM API로 노출되지 않는** 직렬화기 내부 가드다. 직접 단정 불가 — **비단정(non-asserting) 회귀 감시만**. — **UNTESTABLE-BLACKBOX.** `test:` 셀 분할 후 export→reload가 손상 없이 열림을 간접 단정.
28. **`applyHfTemplate`의 `apply_to` 의미론.** `applyHfTemplate(section_idx, is_header, apply_to, template_id)` — `apply_to`: **0=첫 페이지만, 1=전체, 2=첫 페이지 제외 전체**. **다중 섹션 머리말/꼬리말은 후속 섹션에 자동 전파되지 않으므로** 각 섹션에 개별 적용해야 한다. — **CONFIRMED (d.ts).** `test:` 시그니처 존재 + 다중 섹션 비전파 단정.

---

## Behavioral Guarantee Matrix

| Operation | 입력: genuine .hwp | 입력: .hwpx |
|---|---|---|
| **read tables** (주소 기반 그리드) | WORKS | WORKS |
| **body text edit** (`insertText`/`deleteText`) | WORKS | WORKS |
| **find/replace — `replaceAll`** | **FAILS-SILENTLY** (verified=false; 편집 조용히 드롭) | WORKS (raw_stream 없음) |
| **find/replace — `replaceText`(위치) / safe path** | WORKS | WORKS |
| **in-cell edit** (`insertTextInCell`/`deleteTextInCell`) | WORKS | WORKS |
| **in-cell edit — OOB cell (`cell_idx≥cellCount`)** | **HANCOM-REJECTED** (throw → undefined 반환, 하드 실패) | HANCOM-REJECTED *(미검증, .hwp 거동으로 추정)* |
| **form fill — 빈 필드** | WORKS | WORKS |
| **form fill — 사전 채워진 필드** | **WORKS+WARN** (#838 char-shape 손실 → 한컴 거부 가능) | WORKS+WARN |
| **table formula** (`evaluateTableFormula`) | WORKS (일회성, 자동 재계산 없음) | WORKS |
| **header/footer apply** (`applyHfTemplate`) | WORKS (다중 섹션 비전파) | WORKS |
| **create-from-scratch** (`emptyDocument`→`insertText`→`exportHwp`) | WORKS (출력 .hwp) | — (입력 없음) |
| **save as HWPX** (`exportHwpx`) | **HANCOM-REJECTED** (스킬 차단; .hwp만 출력) | HANCOM-REJECTED |

> 범례: **WORKS** = export→reload 왕복 생존 검증. **FAILS-SILENTLY** = in-memory 성공 보고하나 reload 시 편집 없음(verified=false), 에러 없음 → **스킬 금지 경로**. **HANCOM-REJECTED** = throw 또는 한컴이 산출물 거부(하드 실패). **WORKS+WARN** = 동작하나 알려진 위험으로 경고 필요. *기울임 주석* = 경험적 미검증(추정).

---

## Version-compat Matrix (알려진 버그 × 버전)

> ⚠️ vendored CHANGELOG는 **`[0.7.10]`까지만** 존재한다(0.7.11~0.7.15 항목 없음). 따라서 0.7.12/0.7.13 열은 **추론(inferred)** 이며 CHANGELOG로 검증되지 않는다. 0.7.15 열만 경험적으로 확인됨.

| 버그 / 가드 | 0.7.10 (CHANGELOG) | 0.7.12 *(inferred)* | 0.7.13 *(inferred)* | 0.7.15 (vendored, 확인) |
|---|---|---|---|---|
| **replaceAll-drop** (.hwp raw_stream 미null) | present | present | present | **present** (미수정 — `insertText`/`deleteText` 우회) |
| **HWPX entity-drop** (`&`/`<`/`>`) | present¹ | fixed | fixed | **fixed** (특수 처리 불필요) |
| **form #838** (사전 채움 char-shape 비보존) | present | present | present | **present** (workaround: 빈 필드만 채움) |
| **cell-padding clamp** (`pad_top+pad_bottom>height`) | **guarded**² | guarded | guarded | **guarded** (엔진 자동 50% 비례 축소) |

> ¹ `HWPX entity-drop`: 0.7.15에서 **정상(fixed)** 임은 경험적으로 확인됨. 0.7.10~0.7.11 회귀 / 0.7.12 안정 수정의 버전 연혁은 구 스킬 문서의 주장이며 vendored CHANGELOG로는 **확인 불가**(원 엔티티 복원은 PR #400, `[0.7.8]`).
> ² `cell-padding clamp` 가드는 Task #501(`[0.7.9]` 릴리스 / v0.7.8 후속 사이클)에서 도입되어 **0.7.10에 이미 적용**되어 있다.

---

## Catalog → Rule 추적표 (커버리지 감사)

워크플로 탐색이 채굴한 21개 코너케이스가 각각 위 규칙에 매핑됨(키스톤 보장: "모든 코너케이스 = 테스트 하나").

| Catalog | 주제 | Rule | Catalog | 주제 | Rule |
|---|---|---|---|---|---|
| #1 | merge-origin 저장 | 1 | #12 | insertTextLogical 컨트롤 카운트 | 16 |
| #2 | 중첩 표 | 3 | #13 | 폼 #838 | 17–19 |
| #3 | 범례/작성요령 필터 | 4 (SPEC-FIRST) | #14 | evaluateTableFormula | (Matrix) |
| #4 | 플레이스홀더 정규화 | 6 (SPEC-FIRST) | #15 | HWPX 엔티티 | 20 |
| #5 | 마커/라벨 폼 | 5 (SPEC-FIRST) | #16 | NFD/NFC 파일명 | 21 |
| #6 | U+2007 전각공백 | 7 | #17 | PUA tofu | 22 |
| #7 | cellCount=원점만 | 2 | #18 | getPageTextLayout 근사 | 8 |
| #8 | replaceAll 드롭 | 9 | #19 | control_mask 가드 | 27 (non-asserting) |
| #9 | 안전 경로 insert/delete | 10–15 | #20 | cell-padding clamp | 26 |
| #10 | OOB 셀 throw | 15 | #21 | HWPX 출력 거부 | 23 |
| #11 | header/footer apply_to | 28 | | | |

**관련 파일(절대 경로):** `/Users/ybang_mac/Development/side-projects/rhwp-cli/hwp/src/lib/_bootstrap.mjs`, `.../hwp/src/lib/verify.mjs`, `.../hwp/vendor/rhwp/rhwp.d.ts`, `.../hwp/vendor/rhwp/VERSION` (= `0.7.15`).
