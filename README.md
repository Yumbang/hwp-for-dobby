# hwp — AI 에이전트를 위한 HWP/HWPX 스킬

**한글 문서(`.hwp` / `.hwpx`)를 AI 에이전트가 직접 읽고, 표를 정확히 추출하고, 편집·생성할 수 있게 해 주는 Claude 스킬.**

목표(north-star)는 Anthropic 공식 `docx` / `pdf` 스킬과 같은 수준의 한글 문서 지원 — 정확한 파싱(특히 표)과 실제로 저장까지 확인되는 편집 — 을 **claude.ai · cowork · Claude Code에서 동일하게** 제공하는 것입니다.

엔진은 서드파티 **rhwp**(`@rhwp/core`, Rust→WASM, MIT — [edwardkim/rhwp](https://github.com/edwardkim/rhwp))이며 `vendor/rhwp/`에 벤더링해 **0.7.19**로 고정했습니다. 이 저장소는 그 엔진을 감싸는 얇지만 방어적인 래퍼입니다. 엔진은 빌려 쓸 뿐 우리 것이 아니므로, **알려진 한계는 감추지 않고 문서화하고 테스트로 고정**합니다.

## 왜 래퍼가 필요한가

rhwp를 그냥 호출하면 사용자 문서가 **에러 없이 조용히** 손상될 수 있습니다. 이 스킬이 막는 네 가지가 사실상 존재 이유입니다.

| 위험 | 무슨 일이 벌어지나 | 이 스킬의 방어 |
|---|---|---|
| **사라지는 편집** | HWP5 직렬화기는 섹션의 원본 바이트(`raw_stream`)를 캐시해 두고 그대로 내보낸다. 편집이 메모리에선 성공하고 저장 시 조용히 증발할 수 있다 | 모든 편집을 `exportVerify`로 통과시킨다 — 저장 후 **디스크에서 다시 읽어** 확인하고 `verified` 필드로 보고. `verified: false`는 실패(exit 5)이지 성공이 아니다 |
| **메모 삭제** | 엔진 IR은 메모(메모/주석)를 모델링하지 않는다. 메모가 있는 섹션을 건드리는 순간 저장 시 그 섹션의 메모가 **전부** 사라진다 | 편집 전 `assertMemoSafe`가 컨테이너를 직접 파싱해 메모를 탐지하고 **차단**(exit 6). `--allow-memo-loss`로만 우회 |
| **표 데이터 오배치** | 병합 셀의 텍스트는 원점 셀에만 한 번 저장된다. 평문으로 flatten하면 엉뚱한 행에 붙어 레코드 단위 해석이 조용히 어긋난다 | `extract_tables.mjs`가 `{row, col, rowSpan, colSpan}` 주소로 그리드를 복원. `read.mjs`는 기본(strict)에서 **표 flatten을 아예 거부** |
| **변경 내용 추적 삭제 · 오독** | 메모와 같은 이야기가 한 단계 더 나쁜 형태로. 추적된 문서에서 **삭제된 텍스트는 문단 레코드에 그대로 남아 있어**, 평범하게 읽으면 저자가 이미 지운 글이 살아 있는 본문과 섞여 나온다. 그리고 엔진이 추적 정보를 모델링하지 않으므로 편집 한 번에 전부 사라진다 | `read.mjs`가 추적이 **실제로 있을 때만** 경고를 먼저 출력하고, `--track-changes`로 삽입/삭제를 나눠 보여 준다. 편집은 `assertTrackChangeSafe`가 **차단**(exit 6), `--allow-trackchange-loss`로만 우회 |

---

## 요구 사항

- **Node.js 18 이상** — 확인: `node --version`
- **`npm install` 불필요.** WASM 엔진이 `vendor/rhwp/`에 함께 들어 있어 런타임 의존성이 0입니다. (`npm install`은 엔진 버전을 올리는 유지보수 작업에만 필요)
- (선택) **enhanced 티어**용 rhwp 네이티브 CLI → [C. enhanced 티어](#c-enhanced-티어--rhwp-네이티브-바이너리-claude-code-전용)

---

## 설치

### A. 에이전트에 스킬 설치하기

저장소를 아무 데나 받고, 딸려 있는 설치 명령으로 **쓰는 에이전트에 맞춰** 설치합니다.

```bash
# 1. 저장소 (스킬 본체이자 엔진)
git clone https://github.com/Yumbang/hwp-for-dobby.git ~/dev/hwp-for-dobby
cd ~/dev/hwp-for-dobby

# 2. 스킬을, 쓰는 에이전트에 맞춰
node scripts/install-skill.mjs install                              # Claude Code, 모든 프로젝트
node scripts/install-skill.mjs install --project                    # 지금 이 프로젝트에만
node scripts/install-skill.mjs install --target agents --project    # Codex, Cursor, Zed, Aider…
```

관리 명령은 한 묶음입니다 — 설치한 옵션 그대로 되돌립니다.

```bash
node scripts/install-skill.mjs list        # 모든 타깃 · 스코프의 설치 경로와 현재 상태
node scripts/install-skill.mjs status      # 설치돼 있나? 최신인가, 업그레이드 후 낡았나?
node scripts/install-skill.mjs uninstall [--target agents] [--project]
node scripts/install-skill.mjs install --dry-run     # 무엇이 바뀔지만 출력
```

**`status`는 저장소를 업데이트한 뒤마다 돌릴 만합니다.** 설치본은 스스로 갱신되지 않고, 코드가 더 이상 하지 않는 동작을 설명하는 스킬은 **없느니만 못합니다** — 에이전트가 그 설명을 확신을 갖고 따르기 때문입니다. `status`는 설치본과 저장소의 내용 해시를 비교해 최신이면 exit 0, 낡았으면 **exit 5**, 아예 없으면 exit 3으로 끝나므로 스크립트에서도 씁니다.

| 타깃 | Global | Project |
|---|---|---|
| `claude` | `~/.claude/skills/hwp-for-dobby/` | `./.claude/skills/hwp-for-dobby/` |
| `agents` | `~/.agents/skills/hwp-for-dobby/` | `./.agents/skills/hwp-for-dobby/` + `AGENTS.md` |

Claude Code는 스킬을 **스스로 탐지**하므로 `claude` 타깃은 스킬 디렉터리만 씁니다 — `CLAUDE.md`는 건드리지 않습니다. `agents` 타깃은 `AGENTS.md`에 짧은 포인터 섹션을 추가하는데, 그 에이전트들에는 스킬 자동 탐지가 없어서 **포인터가 곧 탐지 수단**이기 때문입니다(원치 않으면 `--no-agents-md`). 섹션은 HTML 마커 사이에 들어가므로 재실행하면 제자리에서 갱신되고 나머지 내용은 건드리지 않습니다. 경로는 상대경로로 적히므로 프로젝트 스코프 설치는 **커밋해서 팀원·CI가 체크아웃만으로 받게** 할 수 있습니다.

설치는 **깨끗한 교체**입니다. 재설치하면 이전 버전에만 있던 파일이 남지 않습니다. 그리고 설치 명령은 **자기가 만들지 않은 것을 지우지 않습니다** — 대상 경로가 심링크이거나 이 스킬이 아닌 디렉터리면 exit 6으로 거부하고 `--force`를 안내합니다.

**설치 확인**

```bash
node scripts/install-skill.mjs list
node ~/.claude/skills/hwp-for-dobby/src/core/info.mjs samples/fixture-table.hwp
# → {"input":...,"engineVersion":"0.7.19","sourceFormat":"hwp","pageCount":6,...}
```

그다음 Claude Code를 **새 세션으로 시작**하면 `/hwp`로 부르거나, 그냥 "이 hwp 파일 읽어 줘"처럼 말해도 자동으로 잡힙니다.

> **스킬을 직접 고치면서 쓸 때**는 복사 대신 심링크가 편합니다(편집이 즉시 반영):
> ```bash
> ln -s ~/dev/hwp-for-dobby ~/.claude/skills/hwp-for-dobby
> ```
> 대신 대상 폴더를 옮기거나 이름을 바꾸면 스킬이 **아무 에러 없이 목록에서 사라집니다.** `install`은 이 심링크를 덮어쓰지 않고 거부하며, `list`가 `linked`로 표시해 줍니다. `/hwp`가 안 보이면 `node scripts/install-skill.mjs list`부터 확인하세요.

스킬이 저장소와 함께 있으므로, **저장소를 업데이트하고 `install`을 다시 돌리면 둘은 항상 같은 버전**입니다 — 어긋날 수가 없습니다.

### B. claude.ai (웹 · 데스크톱 앱)

**1) 스킬 ZIP 빌드** — `zip` / `unzip` 명령이 필요합니다.

```bash
npm run build
# → {"ok":true,"outputPath":".../dist/hwp-for-dobby.zip","entryCount":47,"bytes":...}
```

`dist/hwp-for-dobby.zip`에는 런타임에 필요한 것만 들어갑니다(허용목록: `SKILL.md`, `README.md`, `package.json`, `LICENSE.txt`, `spec/`, `src/`, `vendor/rhwp/`). `test/`·`samples/`·`scripts/`·`node_modules/`는 들어가지 않으며, 빌드는 **바이트 단위로 재현 가능**합니다(같은 커밋 → 같은 sha256).

이 허용목록은 `scripts/_payload.mjs`에 **한 번만** 정의되어 ZIP 빌드와 `install-skill.mjs`가 함께 씁니다. 그래서 claude.ai에 올린 스킬과 Claude Code에 설치된 스킬이 서로 다른 내용일 수 없습니다.

**2) claude.ai에서 코드 실행 기능을 먼저 켭니다.** 스킬은 코드 실행 환경에서 동작하므로 이게 꺼져 있으면 업로드해도 쓸 수 없습니다.

**3) 설정 → Skills**에서 ZIP을 업로드합니다. (메뉴 명칭은 버전에 따라 `Capabilities` / `Features` / `Customize` 하위에 있습니다.)

알아 둘 점:

- 업로드한 스킬은 **계정 개인용**이며 **서피스 간 동기화되지 않습니다.** Claude Code에 깔아도 claude.ai에는 따로 올려야 합니다.
- **enhanced 티어는 claude.ai에서 동작하지 않습니다.** 네이티브 바이너리를 쓸 수 없기 때문입니다. 해당 스크립트는 exit 4와 안내 메시지로 정직하게 실패하고, **core 14개는 전부 정상 동작**합니다.
- 업로더가 "스킬 폴더 이름이 스킬 이름과 다르다"며 거부하면, ZIP 최상위에 `hwp-for-dobby/` 폴더를 만들어 감싸서 올리세요:
  ```bash
  rm -rf dist/wrap && mkdir -p dist/wrap/hwp-for-dobby
  unzip -q dist/hwp-for-dobby.zip -d dist/wrap/hwp-for-dobby
  (cd dist/wrap && zip -qr ../hwp-for-dobby-folder.zip hwp-for-dobby)
  ```

### C. enhanced 티어 — rhwp 네이티브 바이너리 (Claude Code 전용)

**core 14개 스크립트는 바이너리 없이 전부 동작합니다.** 아래 4개만 네이티브 CLI가 필요합니다.

| 스크립트 | 기능 |
|---|---|
| `src/enhanced/render.mjs` | 페이지 → PNG (비전 판독용) |
| `src/enhanced/export_pdf.mjs` | PDF 내보내기 |
| `src/enhanced/read_precise.mjs` | 정밀 텍스트 / **진짜 표 그리드가 있는 마크다운** |
| `src/enhanced/debug.mjs` | IR 덤프 · ir-diff · 썸네일 |

바이너리가 없으면 네 스크립트 모두 **exit 4 + 안내 메시지**로 끝납니다. 그때는 core 스크립트로 대체하면 됩니다.

**탐색 순서:** `$RHWP_BIN` → `vendor/bin/rhwp-<platform>-<arch>` → `PATH`의 `rhwp`

**플랫폼별 자산 이름**

| 플랫폼 | 릴리스 자산 | `vendor/bin/` 파일명 |
|---|---|---|
| macOS Apple Silicon | `rhwp-v0.7.19-macos-aarch64.tar.gz` | `rhwp-darwin-arm64` |
| macOS Intel | `rhwp-v0.7.19-macos-x86_64.tar.gz` | `rhwp-darwin-x64` |
| Linux x86_64 | `rhwp-v0.7.19-linux-x86_64.tar.gz` | `rhwp-linux-x64` |
| Windows x86_64 | `rhwp-v0.7.19-windows-x86_64.zip` | `rhwp-win32-x64.exe` |

**설치 (macOS Apple Silicon 예시)** — 다른 플랫폼은 위 표의 자산 이름과 파일명만 바꾸면 됩니다.

```bash
cd ~/.claude/skills/hwp-for-dobby
mkdir -p vendor/bin
curl -sSL -o /tmp/rhwp.tar.gz \
  https://github.com/edwardkim/rhwp/releases/download/v0.7.19/rhwp-v0.7.19-macos-aarch64.tar.gz
tar xzf /tmp/rhwp.tar.gz -C /tmp          # → /tmp/rhwp/rhwp
cp /tmp/rhwp/rhwp vendor/bin/rhwp-darwin-arm64
chmod +x vendor/bin/rhwp-darwin-arm64
xattr -d com.apple.quarantine vendor/bin/rhwp-darwin-arm64 2>/dev/null || true   # macOS 격리 해제
```

`vendor/bin/`은 `.gitignore`에 있으므로 `git pull`로 덮어써지지 않습니다.

**대안 1 — 아무 데나 두고 환경변수로 지정** (셸 프로필에 넣어 두면 편합니다):

```bash
export RHWP_BIN=/opt/rhwp/rhwp
```

**대안 2 — `PATH`에 두기**: `rhwp` 실행 파일을 `/usr/local/bin` 등에 놓습니다.

**동작 확인**

```bash
node src/enhanced/read_precise.mjs samples/fixture-table.hwp --format markdown | head -5
```

> 벤더링된 WASM(0.7.19)과 **CLI 버전을 맞추세요.** 버전이 어긋나면 `spec/rhwp-behavior.md`의 동작 명세가 CLI 쪽에서는 보장되지 않습니다.

#### ⚠️ PNG 렌더는 공식 릴리스 바이너리로는 안 됩니다

공식 릴리스 바이너리는 **`native-skia` 기능 없이** 빌드되어 있습니다(2026-08-03, v0.7.19 `macos-aarch64`에서 확인). `rhwp export-png`는 `native-skia feature 가 활성화되어야 합니다`를 출력하면서 **exit 0인 채로 아무 파일도 쓰지 않습니다** — 스킬은 이 상황을 잡아내 `render.mjs`를 exit 4로 정직하게 실패시킵니다.

**PDF · 텍스트 · 마크다운 · IR 덤프는 릴리스 바이너리로 정상 동작합니다.** PNG가 꼭 필요하면 소스에서 직접 빌드하세요(Rust 툴체인 필요, skia 빌드는 시간과 디스크를 많이 씁니다):

```bash
git clone https://github.com/edwardkim/rhwp.git && cd rhwp
git checkout v0.7.19
cargo build --release --features native-skia
cp target/release/rhwp ~/.claude/skills/hwp-for-dobby/vendor/bin/rhwp-darwin-arm64
```

---

## 빠르게 써 보기

저장소에 딸린 샘플로 바로 확인할 수 있습니다.

```bash
# 낯선 파일 파악 — 쪽수·표 유무·메모 개수·폰트·엔진 버전
node src/core/info.mjs samples/fixture-table.hwp

# 본문 읽기 (표는 flatten 거부 — 자리표시자 + 경고)
# 기본: 절 스냅샷을 찍고, 두 번째 읽기부터 stderr에 지난 읽기 이후 변경을 보고한 뒤 기준선을 갱신
node src/core/read.mjs samples/fixture-table.hwp --format text
# 스냅샷 없이: --no-snapshot

# 표 데이터는 반드시 이걸로 (병합 셀 주소 복원)
node src/core/extract_tables.mjs samples/fixture-table.hwp --format markdown

# 메모 읽기 — 메모 본문 + 어느 본문에 달렸는지(anchor)까지
node src/core/read.mjs samples/fixture-memo.hwpx --memos

# 변경 내용 추적 — 삽입/삭제를 나눠서 (평범한 읽기는 둘을 섞어서 보여 줍니다)
node src/core/read.mjs samples/fixture-table.hwp --track-changes --format text
# → (no tracked changes)

# 찾아 바꾸기 (본문 + 표 셀 + 글상자, 저장 후 재검증)
node src/core/replace.mjs samples/fixture-table.hwp \
  --query 25,002 --replacement 99,999 --output /tmp/out.hwp
```

안전장치가 실제로 작동하는지 보려면 메모가 있는 파일을 편집해 보세요:

```bash
node src/core/replace.mjs samples/fixture-memo.hwpx --query 테스트 --replacement X --output /tmp/o.hwp
# → exit 6, "이 문서에는 메모 1개가 있고 엔진이 보존할 수 없다. 거부한다."
```

### 문서를 "구조"로 읽기 — `sections.mjs`

40쪽짜리 보고서에서 §4.3만 꺼내거나, 섹션 하나씩 서브에이전트에 넘기거나, 지난주 이후 공저자가 **어느 절을 고쳤는지** 보는 용도입니다.

```bash
# 개요 (heading tree)
node src/core/sections.mjs samples/fixture-headings.hwp --op outline
```

```
1  1. 사업 개요  (10 block(s))
  1.1  □ 추진 배경  (7 block(s))
    1.1.1  ○ 국내 현황  (4 block(s))
      1.1.1.1  - 시장 규모 연 12% 성장  (2 block(s))
      1.1.1.2  - 주요 사업자 현황  (1 block(s))
    1.1.2  ○ 해외 현황  (2 block(s))
  1.2  □ 추진 목표  (2 block(s))
2  2. 추진 체계  (3 block(s))
  2.1  □ 조직 구성  (2 block(s))
    2.1.1  ○ 총괄 부서  (1 block(s))
3  3. 기대 효과  (3 block(s))
```

```bash
# 조문 문서에서 한 조만 (--id 는 서수 경로 2.3.1 · 문서 참조 제12조/T0 · 정확한 제목 모두 받습니다)
node src/core/sections.mjs samples/fixture-clause.hwp --op extract --id 제1조
```

```
# 제1조(목적)
<!-- 제1장 총칙 › 제1조(목적) — samples/fixture-clause.hwp -->

이 규정은 학교의 운영에 관한 사항을 정함을 목적으로 한다.
```

```bash
# 섹션별 파일로 쪼개기 (서브에이전트에 하나씩 넘기기 좋게)
node src/core/sections.mjs samples/fixture-headings.hwp --op split --out-dir /tmp/chunks
# → /tmp/chunks/000-1-1.-사업-개요.md  001-2-2.-추진-체계.md  002-3-3.-기대-효과.md

# 스냅샷 찍고, 나중에 무엇이 바뀌었는지
cp samples/fixture-headings.hwp /tmp/보고서.hwp
node src/core/sections.mjs /tmp/보고서.hwp --op snapshot
node src/core/replace.mjs /tmp/보고서.hwp --query 12% --replacement 18% --output /tmp/보고서.hwp
node src/core/sections.mjs /tmp/보고서.hwp --op diff
```

```
M 1.1.1.1  - 시장 규모 연 18% 성장
    국내 시장 규모는 연 [-12%-] {+18%+} 성장하고 있다.

0 added, 0 removed, 1 changed, 0 moved, 10 unchanged
```

**구조는 읽는 게 아니라 추론합니다 — 그리고 그 사실을 매번 밝힙니다.** 한글 문서에는 개요 메타데이터가 사실상 없습니다(`headType`/`paraLevel`/`numberingId`가 거의 100% None/0/0, 개요 1..7 스타일은 존재하지만 쓰이지 않음). 깊이는 **문서마다** 마커 글리프 + 들여쓰기(□ → ○ → -)에서 학습합니다. 그래서 모든 실행이 stderr에 `detection:` 블록을 씁니다 — 채택된 전략, 사다리(style → clause → marker → table → none)와 각 단계를 **왜** 기각했는지, 필터별 탈락 수, 학습된 마커→레벨 표, 신뢰도, 그리고 엔진 자체 `getStructure`와의 일치율(참고용 두 번째 의견일 뿐입니다. 조문 전용이라 실제 문서 9개 중 6개에서 0개를 반환했습니다):

```
detection: strategy=marker confidence=low
  blocks=25 non-empty=22 tables=0 candidates=11 headings=11 props-probed=22
  ladder 1 style: rejected — 0 heading style(s) actually used on ≥2 paragraphs (needs 2)
  ladder 2 clause: rejected — 0 제N조 (needs 3)
  ladder 3 marker: CHOSEN — adopted 4 class(es)
  levels: NUM1→1 BOX→2 CIRCLE→3 DASH→4
  engine getStructure agreement: engine reported 0 nodes
WARNING: structure detection confidence is LOW (a marker level rests on only 2 line(s)).
```

**"구조 없음"은 정상적인 대답입니다.** 실제 한글 문서 60개에서: 22개는 마커 개요가 나왔고, 26개는 **표 인덱스**로 폴백했으며, 12개는 트리를 지어내는 대신 **exit 3**으로 정직하게 거절했습니다. 거절당했을 때 우회는 두 가지입니다.

```bash
node src/core/sections.mjs <문서> --op outline --detect regex --heading-regex '^제[0-9]+장'
node src/core/sections.mjs <문서> --op outline --marker-level '{"BOX":1,"CIRCLE":2}'
```

본문이 사실상 없는 문서는 빈 트리 대신 **표 인덱스**로 폴백합니다 — 살아남은 제목 후보가 하나도 없거나 비어 있지 않은 본문 블록이 3개 이하이고, 표가 하나라도 있을 때입니다(실제 한글 문서의 약 22%는 본문 문단이 0개이고 전부 표 안에 들어 있습니다). 결과는 `1  표 1  [T0]`, exit 0, 낮은 신뢰도. 이 인덱스는 **길잡이일 뿐**이라 `--op extract --id T0`은 제목만 나오고 본문은 비어 있습니다. 표 데이터는 `extract_tables.mjs`로 읽으세요.

그 밖에 알아 둘 것:

- **수식**은 HWP 수식 스크립트에서 그대로 인라인 렌더됩니다 — `$x^2 + y^2 = z^2$`. pandoc도 OMML도 개입하지 않습니다(한글은 OMML을 쓰지 않습니다). `--equations latex`는 **완전히 매핑된 경우에만** LaTeX로 바꾸고, 아니면 원본 스크립트로 되돌립니다. 반쯤 번역된 수식을 완성품처럼 내놓지 않기 위해서입니다.
- **스냅샷은 캐시가 아니라 사용자 소유 산출물**이라 문서 옆 `.hwp-snapshots/<이름>/`에 저장됩니다(`--snapshot-dir`로 이동). 내용이 그대로면 바이트 단위로 동일하게 다시 쓰이므로 버전 관리에 노이즈가 되지 않습니다. `--op diff`는 출력 후 기준선을 갱신해 "지난 diff 이후"를 뜻하게 합니다(`--no-update`로 유지).
- **`--table-mode`나 원본 포맷이 다른 기준선과의 비교는 exit 2로 거부**합니다. 같은 문서를 `.hwp`로 읽을 때와 `.hwpx`로 읽을 때는 ~100% 변경으로 나오는데, 그걸 결과라고 내놓으면 당당한 거짓말이 되기 때문입니다.
- 파싱한 모델은 **파일의 sha256**을 키로 OS 임시 디렉터리에 캐시됩니다. 문서가 바뀌면 키가 바뀌므로 낡은 트리가 나올 수 없습니다(`--no-cache`로 우회). 가장 큰 픽스처 기준 `--op outline`이 cold 427 ms / warm 61 ms였습니다(`node scripts/bench.mjs`).

전체 스크립트 목록과 옵션은 **[`SKILL.md`](SKILL.md)의 Quick Reference**에 있습니다.

**종료 코드:** `0` 성공 · `1` 로드/파싱 실패 · `2` 잘못된 인자/출력 대상, 비교 불가능한 스냅샷 · `3` 대상 없음(구조를 찾지 못한 경우 포함) · `4` 이 환경에서 불가(enhanced는 CLI 필요) · `5` 손상 감지 또는 왕복 검증 실패 · `6` 데이터 손실 우려로 거부(`--allow-memo-loss` / `--allow-trackchange-loss`로 우회)

---

## 아키텍처 — 3티어, 하나의 능력 경계

| 티어 | 실행 위치 | 내용 |
|---|---|---|
| **`src/core/`** | WASM만 사용 → **모든 플랫폼** | read, sections, extract_tables, info, replace, edit_text, edit_cell, table, format, header_footer, footnote, fill_form, unlock, create |
| **`src/enhanced/`** | 네이티브 rhwp CLI → **Claude Code 전용** | render(PNG), export_pdf, read_precise, debug |
| **`src/lib/`** | 공용 | WASM 부트스트랩, 능력 탐지, 왕복 검증, 메모·변경추적 가드, 안전 치환, 종료 코드, 블록 모델, 개요 탐지, 스냅샷/diff, 수식, 모델 캐시 |

**경계 원칙(불변):** *WASM만으로 되면 `core/`, 네이티브 바이너리가 필요하면 `enhanced/`. core는 절대 조용히 degrade하지 않는다.* 배포 ZIP 하나가 두 티어를 모두 담고, `lib/capabilities.mjs`가 런타임에 `enhanced/`를 게이팅해 CLI가 없으면 exit 4로 안내합니다.

## 출력 정책 — 항상 `.hwp`, 절대 `.hwpx` 아님

출력은 **항상 HWP 5.0(`.hwp`)** 입니다. rhwp가 만든 HWPX는 한컴오피스가 "파일 손상"으로 거부하기 때문에, `lib/_bootstrap.mjs:assertHwpOutput`이 `.hwpx` 출력을 exit 2로 막습니다. **`.hwpx` 입력은 완전히 지원**됩니다(엔진이 내보낼 때 HWPX→HWP 어댑터를 태웁니다). 즉 `.hwpx`를 열어 편집하고 `.hwp`로 저장하는 흐름입니다.

---

## 문서 지도

| 파일 | 대상 독자 | 내용 |
|---|---|---|
| **[`SKILL.md`](SKILL.md)** | 스킬을 **쓰는** 에이전트 | 라우팅 표, 안전 규칙, 실패 모드. 에이전트용 프롬프트이므로 영어 |
| **[`spec/rhwp-behavior.md`](spec/rhwp-behavior.md)** | 파싱/편집 로직을 고치는 사람 | **키스톤 문서.** 0.7.19에서 경험적으로 확인한 엔진 동작 29개 규칙, 각각 `test/spec/`의 테스트 하나와 매핑. 파싱·편집을 건드리기 전에 반드시 읽을 것 |
| **[`CLAUDE.md`](CLAUDE.md)** | 이 스킬을 **고치는** 사람 | 유지보수 계약: 무시하면 물리는 규칙 6가지 |
| `README.md` | 처음 오는 사람 | 이 문서 |

## 테스트

```bash
npm test    # pin-integrity + smoke + golden + spec(read/tables/sections/headings/snapshot/trackchange/cache/edit-matrix/memo/info/enhanced/install-skill) + skill-doc
```

`npm install` 없이 그대로 돌아갑니다. 네이티브 CLI가 없는 환경에서는 enhanced의 "CLI 있을 때" 케이스만 skip되고, **degrade 보장(exit 4) 테스트는 항상 실행**됩니다. 바이너리를 설치했다면 `$RHWP_BIN` → `vendor/bin` → `PATH` 순으로 자동 탐지해 그 케이스들이 함께 켜집니다.

테스트가 지키는 것들:

- **`test/pin-integrity`** — `vendor/rhwp/VERSION`, `package.json`, `package-lock.json`, 그리고 WASM이 실제로 보고하는 `version()` 넷이 어긋나면 실패. 버전 명세가 거짓말이 되는 걸 막습니다.
- **`test/smoke`** — 셀 편집이 `.hwp` 왕복에서 살아남는지, 일괄 치환이 디스크까지 도달하는지. 후자는 예전엔 **정반대로** 단정하던 테스트입니다(아래 참조).
- **`test/spec/`** — `spec/rhwp-behavior.md`의 규칙별 대응 테스트.
- **`test/spec/corpus.test.mjs`** — **실제 문서**에 대고 돌리는 속성 테스트인데, 기본 경로가 없어 `HWP_CORPUS_DIR=~/Downloads npm test`처럼 사람이 디렉터리를 지정했을 때만 실행됩니다. 남의 실제 문서를 허락 없이 읽는 테스트가 되지 않기 위해서고, 실패 메시지의 식별자는 전부 `doc#<8자리 해시>`로 익명화됩니다(파일명이 터미널·CI 로그·버그 리포트로 새는 걸 막습니다).

> **엔진 회귀 감시.** 0.7.15까지는 진짜 `.hwp`에서 `replaceAll`이 조용히 유실되어 스킬이 검색 + 삭제/삽입으로 우회했습니다. 0.7.16에서 업스트림이 고쳤고(`d0e866da` / PR #1398), 우회 경로는 제거됐습니다. 지금 테스트는 **고쳐진 상태를 지키는** 방향이며, 여기가 빨개지면 엔진이 회귀한 것이니 `spec/rhwp-behavior.md` 규칙 11의 우회 경로를 되살려야 합니다.

## 유지보수

```bash
npm run bump <version>   # 엔진 버전 올리기 (게이트 통과해야만 수락)
npm run vendor-sync      # node_modules/@rhwp/core → vendor/rhwp/ 재복사 + sha256 검증
npm run build            # dist/hwp-for-dobby.zip 재생성
npm run skill -- status  # 설치본이 이 저장소와 같은 버전인지 (= node scripts/install-skill.mjs)
```

엔진 버전 변경은 스킬 전체를 조용히 썩힐 수 있는 유일한 작업이라 게이트가 걸려 있습니다. `npm run bump`은 (1) 작업 트리가 깨끗한지 확인 → (2) `npm install @rhwp/core@<version> --save-exact` → (3) vendor-sync + 바이트 검증 → (4) `npm test` 전량 통과, 이 순서를 모두 만족할 때만 수락하고, 실패하면 **거부**하며 `git checkout .`으로 되돌리라고 안내합니다. 벤더링된 파일은 절대 손으로 고치지 마세요.

스크립트를 추가할 때는 `core/`인지 `enhanced/`인지 먼저 정하고, `../lib/`에서 import하고, [`CLAUDE.md`](CLAUDE.md)의 규칙을 따른 뒤 `test/spec/` 케이스를 추가하세요.

## 현재 상태

3티어(core / enhanced / lib)와 패키징까지 구현이 끝났고 테스트는 green입니다. 엔진은 rhwp **0.7.19** 고정입니다(업스트림은 그 이후로도 나오고 있으므로, 올릴 때는 반드시 `npm run bump`의 게이트를 통과시키세요).

최근에 더해진 것은 **문서를 구조로 다루는 층**입니다 — `sections.mjs`의 다섯 가지 op(outline / extract / split / snapshot / diff), 문서마다 학습하는 개요 탐지와 그 근거를 매번 출력하는 `detection:` 블록, 섹션 단위 스냅샷·diff, HWP 수식 인라인 렌더, 그리고 **변경 내용 추적 탐지 + 편집 차단**입니다. 개요를 못 찾는 것도 정상적인 결과로 취급합니다(exit 3, 우회 두 가지).

이 빌드에서 살아 있는 알려진 한계 — 모두 문서화·테스트되어 있습니다:

- **폼 #838** — 이미 값이 채워진 필드를 다시 채우면 글자 모양 메타가 어긋나 한컴이 거부할 수 있습니다(경고 출력). 빈 필드 채우기는 깨끗합니다.
- **메모 미모델링** — 메모가 있는 문서 편집은 기본 차단(exit 6).
- **변경 내용 추적 미모델링** — 추적이 있는 문서 편집도 기본 차단(exit 6, `--allow-trackchange-loss`). 평범한 읽기는 삭제된 텍스트까지 섞어서 내보내므로 경고를 함께 출력합니다. **HWPX는 스캔할 수 없어** "확인 못 함"으로 보고합니다 — "없음"이 아닙니다.
- **개요 메타데이터 부재** — 한글 문서에는 읽을 개요 정보가 없어 `sections.mjs`가 텍스트에서 **추론**합니다. 추측이므로 신뢰도와 근거를 매번 함께 출력하며, 낮은 신뢰도에서는 크게 경고합니다.
- **도형 / 차트 / 스타일 시스템** — 이 엔진 빌드에서 미지원.
- **HWPX 출력** — 한컴이 거부하므로 금지(`.hwpx` 입력은 지원).

## 라이선스

이 스킬은 MIT입니다([`LICENSE.txt`](LICENSE.txt)). 엔진 rhwp도 MIT이며 `vendor/rhwp/LICENSE`에 원 라이선스를 함께 담았습니다. 엔진의 저작자는 [edwardkim/rhwp](https://github.com/edwardkim/rhwp)입니다 — 이 저장소는 그 위에 얹은 래퍼일 뿐입니다.
