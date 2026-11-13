# Hướng dẫn đóng góp

Tài liệu này quy định quy trình làm việc chung của nhóm, từ lúc nhận ticket trên Jira cho tới khi ticket được đóng.

Mọi thành viên đều phải tuân thủ quy trình này.

## Mục lục

- [Mô hình phát triển: Trunk-Based Development (TBD)](#mô-hình-phát-triển-trunk-based-development-tbd)
- [Tổng quan quy trình](#tổng-quan-quy-trình)
- [Bước 1: Nhận ticket trên Jira](#bước-1-nhận-ticket-trên-jira)
- [Bước 2: Tạo branch từ `main`](#bước-2-tạo-branch-từ-main)
- [Bước 3: Code và commit](#bước-3-code-và-commit)
- [Bước 4: Đẩy branch lên remote](#bước-4-đẩy-branch-lên-remote)
- [Bước 5: Đồng bộ với `main`](#bước-5-đồng-bộ-với-main)
- [Bước 6: Mở Pull Request](#bước-6-mở-pull-request)
- [Bước 7: Review](#bước-7-review)
- [Bước 8: Merge](#bước-8-merge)
- [Bước 9: Dọn dẹp và đóng ticket](#bước-9-dọn-dẹp-và-đóng-ticket)

---

## Mô hình phát triển: Trunk-Based Development (TBD)

Nhóm áp dụng **Trunk-Based Development**: **trunk của repo là nhánh `main`** - thành viên làm việc trên các **short-lived branch** tách từ `main`, merge lại ngay sau khi hoàn thành.

- `main` luôn ở trạng thái **sẵn sàng release** tại mọi thời điểm.
- Nhóm có thể **demo trực tiếp từ `main`** tại bất kỳ thời điểm nào (cuối mỗi sprint/milestone) mà không cần branch riêng để "ổn định hóa" trước demo.
- Không commit trực tiếp lên `main` - mọi thay đổi đều đi qua Pull Request.

---

## Tổng quan quy trình

| Bước | Việc cần làm | Kết quả |
|------|--------------|---------|
| 1 | Nhận ticket trên Jira, chuyển `To Do` → `In Progress` | Status của ticket là `In Progress` |
| 2 | Cập nhật `main`, tách branch mới | Branch ngắn hạn theo đúng quy ước tên |
| 3 | Code và commit | Các commit nhỏ (khuyến khích), message tiếng Anh |
| 4 | Push branch lên remote | Branch đã có trên GitHub |
| 5 | Rebase `main` mới nhất vào branch và xử lý hết conflict | Branch không còn lệch `main`, hết conflict |
| 6 | Mở Pull Request (ticket được Jira automation tự chuyển sang `In Review`), **tự review lại toàn bộ diff**, chuyển **Ready for review** | PR đúng định dạng tiêu đề, đã điền template, chủ PR hiểu rõ mọi thay đổi |
| 7 | Request review, sửa theo góp ý | Đủ approve, mọi conversation đã resolve, CI pass |
| 8 | **Squash and merge** vào `main` | `main` có thêm đúng 1 commit |
| 9 | Khuyến khích xoá branch ở local sau khi merge (branch remote được GitHub tự xoá, ticket được Jira automation tự chuyển sang `Done`) | Ticket đã đóng; branch remote đã xoá, branch local có thể xoá hoặc giữ lại |

---

## Bước 1: Nhận ticket trên Jira

Vòng đời status của một ticket:

```
Luồng chính:  To Do → In Progress → In Review → Done

Blocked:      Blocked → To Do                    (tự động khi đã hết blocker)
Cancelled:    mọi status trừ Done → Cancelled    (khi ticket bị huỷ)
```

- Phần lớn ticket đi thẳng luồng chính, bắt đầu từ `To Do`.
- `Blocked`: dành cho ticket chưa làm được vì còn phụ thuộc ticket khác. Ticket tự động chuyển về `To Do` khi **tất cả** ticket block nó đều đã `Done`. Chỉ cần còn một ticket block chưa xong thì nó vẫn ở `Blocked`.
- `Cancelled`: ticket bị huỷ, không làm nữa. Có thể chuyển sang `Cancelled` từ bất kỳ status nào **trừ** `Done`. PR tương ứng (nếu có) cũng đóng lại mà không merge.

Quy tắc:

- Mỗi phần công việc đều phải có **ticket trên Jira** trước khi bắt đầu code.
- Khi bắt đầu làm, tự assign ticket cho mình và chuyển status từ `To Do` → `In Progress`.
- Các bước chuyển status còn lại do Jira automation tự xử lý, **không cần chuyển tay**:
  - Mở PR (kể cả Draft): `In Progress` → `In Review`. Ticket ở lại `In Review` trong suốt quá trình review.
  - PR được merge vào `main`: `In Review` → `Done`.
  - Ticket `Blocked` hết blocker: `Blocked` → `To Do`.
- Nếu ticket có khối lượng công việc lớn, chủ động **tách thành nhiều ticket/branch nhỏ**. PR nhỏ giúp reviewer dễ đọc, review nhanh và chính xác hơn, đồng thời hạn chế conflict.
- Nếu ticket của mình đang ở trạng thái `Blocked`, chủ động **liên hệ và hối thúc người phụ trách ticket đang chặn** để họ hoàn thành sớm, tránh chỉ ngồi chờ đợi bị động (xem thêm chiều ngược lại ở [Bước 9](#bước-9-dọn-dẹp-và-đóng-ticket)).

---

## Bước 2: Tạo branch từ `main`

Luôn tách branch từ `main` **mới nhất**, không tách từ branch của người khác:

```bash
git checkout main
git pull origin main
git checkout -b CDA-12-add-user-login
```

> **Mẹo:** Không cần tự gõ lệnh `git checkout -b`. Trên trang chi tiết ticket ở Jira, mở mục **Create branch**, phần **Git create & checkout a new branch** có sẵn lệnh tạo branch với tên sinh từ mã và tiêu đề ticket, chỉ cần copy về chạy. Trước khi chạy, kiểm tra lại tên branch có đúng [quy tắc đặt tên](#quy-tắc-đặt-tên-branch) bên dưới không.

### Quy tắc đặt tên branch

```
<ticket>-<mô-tả-ngắn-gọn>
```

| Thành phần | Mô tả |
|------------|-------|
| Ticket | Mã task trên Jira, ví dụ `CDA-2`, `CDA-12` |
| Mô tả ngắn gọn | Kebab-case, mô tả công việc |

**Ví dụ:** `CDA-12-add-user-login`

- Viết chữ thường, không dùng khoảng trắng.
- **Tên branch phải viết bằng tiếng Anh** (không dùng tiếng Việt có dấu hoặc không dấu).
- Mỗi branch gắn với **một ticket** và chỉ giải quyết **một mục tiêu**.
- Branch phải **ngắn hạn** - tính từ lúc tách ra tới lúc merge vào `main` càng ngắn càng tốt, không để branch sống lâu trước khi merge. Việc xoá branch **sau khi** merge xem [Bước 9](#bước-9-dọn-dẹp-và-đóng-ticket).

---

## Bước 3: Code và commit

```bash
git add <file>                  # stage từng file
git add .                       # stage toàn bộ thay đổi
git commit -m "add login form"
```

### Quy tắc commit

- Commit message viết bằng **tiếng Anh**.
- Trên **nhánh riêng**, có thể commit bao nhiêu tùy thích - các commit sẽ được gộp lại khi squash merge.
- Commit theo từng phần việc nhỏ, tránh dồn toàn bộ thay đổi vào một commit khổng lồ (khuyến khích).
- **Không commit file nhạy cảm** (`.env`, key, mật khẩu, credentials) và file build/artifact.
- **Không để lại dấu vết AI trong commit/PR**: dù dùng AI hỗ trợ viết code, commit message và PR description không được có trailer đồng tác giả kiểu `Co-Authored-By: Claude ...` hay footer "Generated with ..." - tác giả commit/PR luôn là người.

---

## Bước 4: Đẩy branch lên remote

```bash
git push -u origin CDA-12-add-user-login   # lần đầu tiên
git push                                   # các lần sau
```

Nên push sớm và push thường xuyên để công việc không nằm hết ở máy local.

---

## Bước 5: Đồng bộ với `main`

Trước khi mở PR (và trước khi merge), branch phải được đồng bộ với `main` mới nhất. Nhóm **chỉ dùng `rebase`**, **không dùng `git merge`** để đồng bộ - mục đích là giữ lịch sử tuyến tính, sạch sẽ, không có commit merge rác trong branch:

Đứng ngay tại branch của mình và chạy:

```bash
git pull --rebase origin main
```

Sau khi rebase, lịch sử branch đã bị viết lại nên cần force push (chỉ dùng trên nhánh riêng của mình, **không bao giờ** dùng trên `main`):

```bash
git push --force-with-lease
```

> Dùng `--force-with-lease` thay vì `--force`: nếu có người khác vừa push lên cùng branch, lệnh sẽ dừng lại thay vì ghi đè mất commit của họ.

> **Lưu ý:** `git merge main` bị cấm trong quy trình của nhóm. Nếu lỡ tay merge, hãy gỡ commit merge ra rồi rebase lại.

### Khi có conflict

Quy ước của nhóm: nếu conflict nằm ở phần code của người khác, hãy **liên hệ người đó để cùng xử lý**, hoặc tự xử lý rồi **nhờ họ review lại**, tránh làm sai logic có sẵn.

---

## Bước 6: Mở Pull Request

### Tiêu đề PR

```
<ticket> <type>: <mô tả ngắn gọn>
```

| Type | Ý nghĩa |
|------|---------|
| `feat` | Thêm tính năng mới |
| `fix` | Sửa lỗi |
| `docs` | Thay đổi tài liệu |
| `style` | Định dạng code (không đổi logic) |
| `refactor` | Tái cấu trúc code |
| `test` | Thêm hoặc sửa test |
| `chore` | Bảo trì, cấu hình, dependency |
| `perf` | Cải thiện hiệu năng |
| `ci` | Thay đổi CI/CD |

**Ví dụ:** `CDA-12 feat: add user login`

> **Lưu ý:** Phần `<mô tả ngắn gọn>` trong tiêu đề PR phải viết bằng **tiếng Anh**. Nếu tiêu đề sai định dạng, CI `PR Title Lint` sẽ fail.

### Nội dung PR

Điền [template PR](.github/pull_request_template.md). Mục tiêu: người chưa đọc ticket và chưa mở diff, chỉ cần đọc **Tóm tắt** và **Ví dụ** là trả lời được ba câu: PR thay đổi hành vi gì, vì sao, và chưa làm gì. Các mục sau đó giúp reviewer hiểu PR làm như thế nào.

| Mục | Nội dung |
|-----|----------|
| Tóm tắt | Trước, sau, vì sao, phần chưa làm, mã ticket (ví dụ `CDA-12`, GitHub tự chuyển thành link Jira). Mỗi dòng tối đa 2 câu. Chưa làm là chỗ duy nhất ghi việc để lại cho sau. Dòng Ticket ghi thêm ticket mà PR dựa trên và mở đường cho, nếu PR nằm trong một chuỗi ticket. Nếu acceptance criteria (AC) của ticket đã sửa trong lúc làm thì ghi AC nào đổi. |
| Ví dụ | Hành vi mới qua một ví dụ cụ thể: output TUI/CLI, Tool Result, chuỗi Session Event, ... Nếu sửa hành vi có sẵn thì để cả trước và sau. PR không có hành vi mới thì ghi `Không có: <lý do>` |
| Thay đổi | Bản đồ diff, thứ tự nên đọc, thay đổi interface giữa các package. Nếu docs, ADR hay CONTEXT.md bị ảnh hưởng mà không sửa thì ghi lý do. |
| Flow | Sơ đồ Mermaid, bắt buộc khi PR thêm hoặc đổi luồng chạy qua từ 2 thành phần trở lên, thêm hoặc đổi trạng thái của Agent Session, hoặc có vấn đề về thứ tự xử lý, chạy đồng thời |
| Quyết định thiết kế | Chỗ ticket/ADR không quy định sẵn: đã chọn gì, vì sao, phương án bị loại, nhược điểm còn lại |
| Kiểm thử | Lệnh test riêng, kịch bản được bao phủ, phần chưa kiểm thử được (nếu có thay đổi code) |
| Rủi ro | Rủi ro đã biết của phần được merge. Không chép lại việc để lại cho sau (đã ở Chưa làm) hay phần chưa kiểm thử (đã ở Kiểm thử). |
| Checklist | 5 ô chủ PR tự đánh giá, là những việc CI không kiểm được. |

**Tóm tắt** luôn phải có. **Ví dụ** luôn giữ tiêu đề mục. Các mục khác không áp dụng thì xóa. Mỗi ý chỉ ghi ở một mục, mục khác cần nhắc tới thì trỏ sang thay vì chép lại. Không cần ghi lại loại thay đổi (đã có trong tiêu đề PR) hay liệt kê lại các lệnh mà CI đã chạy.

PR tham khảo cách viết: [#76](https://github.com/quangdat2511/coding-agent/pull/76) cho mục Ví dụ và bảng Quyết định thiết kế. [#71](https://github.com/quangdat2511/coding-agent/pull/71) cho mục Flow, sơ đồ chỉ đúng chỗ Gemini từng trả lỗi 400. Hai PR này viết theo bản template trước, khi mục cuối còn tên là Rủi ro và ngoài phạm vi.

> **Lưu ý:** Có thể dùng AI hỗ trợ soạn tiêu đề và mô tả PR, nhưng chủ PR phải **đọc lại toàn bộ trước khi chuyển PR sang Ready for review**, đảm bảo nội dung phản ánh đúng và đầy đủ thay đổi thực tế.

### Kích thước PR

PR càng nhỏ càng tốt, xem quy tắc tách nhỏ ticket/branch ở [Bước 1](#bước-1-nhận-ticket-trên-jira).

### Tự review trước khi chuyển sang Ready for review

**Bắt buộc: chủ PR phải tự review lại toàn bộ diff của mình trước khi chuyển PR sang Ready for review.** Đây không phải là bước hình thức - đây là điều kiện tiên quyết.

Mở tab **Files changed** và đọc lại từng dòng thay đổi như thể đang review code của người khác. Chủ PR phải **giải thích được mọi dòng trong diff**: dòng đó làm gì, tại sao cần có, tại sao làm theo cách đó.

Điều này áp dụng cho cả code do AI sinh ra: dùng AI hỗ trợ thì được, nhưng **không được để lại trong diff đoạn code mà mình chưa đọc kỹ và chưa hiểu**, kiểu thấy "chạy được" nên giữ lại.

### Draft và Ready for review

Reviewer chỉ bắt đầu review khi PR ở trạng thái **Ready for review**.

Trong lúc chưa tự review xong, để PR ở trạng thái **Draft** để tránh reviewer vào xem nhầm lúc chưa sẵn sàng.

**Chỉ chủ PR** mới được chuyển qua lại giữa **Draft** và **Ready for review**. Người khác (kể cả reviewer) không tự ý chuyển trạng thái PR của người khác theo cả hai chiều, vì chỉ chủ PR mới biết PR đã thực sự sẵn sàng hay chưa.

Khi PR được mở ở trạng thái **Ready for review**, hoặc chuyển từ **Draft** sang **Ready for review**, GitHub Actions tự tạo một post trong kênh `#ticket-forum` trên Discord, tag chủ PR và các reviewer đã được request. Reviewer được request sau, review mới (tag chủ PR; comment liên tiếp của cùng một reviewer được gộp thành một tin, gửi sau khi reviewer ngừng comment 2 phút), commit mới khi PR đang Ready (tag reviewer), PR chuyển về Draft, mở lại, merge hoặc đóng đều được báo vào cùng post đó. **Không tạo post cho PR bằng tay**, để tránh mỗi PR có hai post. Cấu hình xem [scripts/README.md](scripts/README.md#discord-pr-posts).

Ngay khi PR được mở (kể cả Draft), ticket tự chuyển sang `In Review` ([Bước 1](#bước-1-nhận-ticket-trên-jira)).

---

## Bước 7: Review

### Điều kiện request review

Chỉ được request review khi PR đã thoả **cả ba** điều kiện sau:

- **PR đang ở trạng thái Ready for review.** Không request review khi PR còn ở Draft ([Bước 6](#bước-6-mở-pull-request)).
- **CI pass toàn bộ.** Không request review khi còn check đỏ - reviewer không phải người đi sửa lint hay test hộ.
- **Branch đã up to date với `main`.** Rebase `main` mới nhất vào branch và xử lý hết conflict trước ([Bước 5](#bước-5-đồng-bộ-với-main)).

Nếu trong lúc chờ review mà `main` đã tiến lên hoặc CI chuyển sang đỏ, chủ PR chủ động rebase và sửa cho xanh lại, không để reviewer phải chờ.

### Với chủ PR

- **Chọn reviewer hợp lý**. Lưu ý mọi reviewer đều phải approve thì PR mới được merge ([Bước 8](#bước-8-merge)).
- Chủ động **request reviewer** ngay khi PR chuyển sang **Ready for review**, không chờ người khác tự vào xem.
- Sửa theo góp ý thì push commit mới lên cùng branch (không cần tạo PR mới).
- Nếu đã quá thời hạn review khuyến nghị (2 ngày) mà chưa nhận được phản hồi, chủ động **nhắc lại reviewer** để tránh PR bị treo quá lâu.

### Với reviewer

- **Bắt buộc review** PR khi được request. Nếu thấy việc mình được request review là không hợp lý, **nêu ý kiến** với chủ PR, không im lặng và bỏ qua không review.
- Chủ động **sắp xếp thời gian review sớm nhất có thể** ngay khi được request, để branch không bị giữ lâu, đúng tinh thần short-lived branch và giúp PR được merge sớm. Nên review xong **trong vòng 2 ngày** kể từ khi được request.
- Đọc **Tóm tắt** và **Ví dụ** trong mô tả PR trước. Nếu chỉ đọc hai mục này mà chưa trả lời được PR thay đổi hành vi gì, vì sao, và chưa làm gì, comment chỉ ra phần còn thiếu hoặc chưa rõ (Trước, Sau, Vì sao, Chưa làm hoặc Ví dụ), kèm câu hỏi cụ thể mà mình chưa trả lời được, để chủ PR sửa mô tả trước, chưa review code. Chủ PR trả lời bằng cách sửa mô tả, không chỉ trả lời trong comment.
- Để lại comment cụ thể, gắn với dòng code cần góp ý.
- Chỉ approve khi đã hiểu rõ chủ PR đang làm gì và đồng ý với thay đổi cũng như hướng triển khai đó.
- Có thể dùng AI hỗ trợ quá trình review và gợi ý nội dung comment, nhưng phải **tự đánh giá gợi ý đó có hợp lý không trước khi đăng comment** - không copy-paste nguyên văn suggestion của AI khi chưa hiểu rõ.
- Khi được chủ PR nhắc lại vì review trễ hẹn, **giữ thái độ tích cực, không xem đó là sự làm phiền** - review sớm giúp đảm bảo tiến độ chung của cả nhóm không bị đình trệ.

### Resolve conversation

Nút **Resolve conversation** đánh dấu một luồng comment đã được xử lý xong. Quy ước của nhóm:

- **Chỉ reviewer - người để lại comment - mới được bấm Resolve conversation.** Chủ PR không tự resolve comment của người khác.
- Chủ PR sửa xong thì **reply ngay dưới comment đó** để reviewer biết (ví dụ: `done in a1b2c3d`, hoặc mô tả ngắn cách đã xử lý).
- Nếu không đồng ý với góp ý, chủ PR reply nêu rõ lý do và **để nguyên thread mở** cho tới khi hai bên thống nhất.
- Reviewer khi quay lại xem: thread nào đã đồng ý với cách xử lý thì bấm resolve, thread nào chưa ổn thì reply tiếp.

Mỗi comment chưa resolve đều phải ở một trong hai trạng thái rõ ràng: **đã có commit sửa** hoặc **đã có reply của chủ PR**. Không để comment nào bị bỏ trống, không hồi đáp.

### Push commit mới lên PR đang chờ review

Trước khi push commit mới lên PR đang ở trạng thái **Ready for review**, chủ PR phải chắc chắn **mọi comment chưa resolve đều đã được xử lý** theo quy ước ở trên.

Nếu chưa xử lý xong mà vẫn cần push (lưu tạm công việc dở dang, còn đang sửa tiếp nhiều chỗ), hãy **chuyển PR về Draft trước khi push**. Xong hết thì chuyển lại **Ready for review** và **request review lại** bằng nút 🔄 cạnh tên reviewer hoặc nhắn trực tiếp cho reviewer để nhờ review lại.

Mục đích: mỗi lần reviewer được gọi vào là một lần PR thực sự sẵn sàng để xem, tránh việc reviewer phải đọc đi đọc lại một PR đang thay đổi liên tục.

---

## Bước 8: Merge

### Điều kiện merge

- **Tất cả reviewer** của PR phải approve, kể cả người không trực tiếp phụ trách task nhưng chủ động yêu cầu được review.
- **Tất cả conversation trên PR phải được resolve** (xem [Bước 7](#bước-7-review)).
- CI pass toàn bộ. Repo hiện có các check **PR title, Biome, import boundary, typecheck, test và build**.
- Nhánh phải được **rebase lên `main` mới nhất** trước khi merge (xem [Bước 5](#bước-5-đồng-bộ-với-main)).

### Ai được merge

- **Chỉ chủ PR** mới được nhấn nút merge trên GitHub. Reviewer chỉ **comment và approve**, không tự ý merge PR của người khác, kể cả khi PR đã đủ điều kiện merge ở trên.

### Cách merge

- Repo chỉ bật **Squash and merge** (các kiểu merge khác đã bị tắt), nên khi merge PR, mọi commit trên branch sẽ được gộp thành **một commit** duy nhất trên `main`.
- Repo đã được cấu hình sẵn: commit message sau squash mặc định là **tiêu đề PR**, ô **Extended description** mặc định để trống. Không cần sửa gì, chỉ việc bấm **Confirm squash and merge**.

---

## Bước 9: Dọn dẹp và đóng ticket

Sau khi PR đã merge, branch coi như xong nhiệm vụ.

Branch ở remote được GitHub **tự động xoá** sau khi merge, không cần làm gì thêm.

Branch ở local thì khuyến khích xoá cho gọn, nhưng không bắt buộc:

```bash
git checkout main
git pull origin main
git branch -D CDA-12-add-user-login    # xoá branch ở local
```

> **Vì sao là `-D` chứ không phải `-d`:** nhóm dùng **Squash and merge**, GitHub tạo ra một commit hoàn toàn mới trên `main` chứ không giữ lại các commit của branch. Git vì thế không nhận ra branch đã được merge và `git branch -d` sẽ báo `error: the branch '...' is not fully merged`. Chỉ dùng `-D` sau khi đã chắc chắn PR đã merge thành công.

### Status ticket sau khi merge

Ticket tự chuyển sang `Done`, và các ticket bị nó block tự về `To Do` nếu không còn blocker nào khác ([Bước 1](#bước-1-nhận-ticket-trên-jira)).

Khi thấy ticket bị block đã về `To Do`, báo ngay cho người đảm nhận (assignee) để họ có thể bắt tay vào làm - đây là chiều ngược lại của quy tắc hối thúc blocker ở [Bước 1](#bước-1-nhận-ticket-trên-jira).

---
