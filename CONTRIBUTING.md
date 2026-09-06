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
| 5 | Rebase `main` mới nhất vào branch và xử lí hết conflict| Branch không còn lệch `main`, hết conflict |
| 6 | Mở Pull Request, **tự review lại toàn bộ diff**, chuyển **Ready for review** | PR đúng định dạng tiêu đề, đã điền template, chủ PR hiểu rõ mọi thay đổi |
| 7 | Request review + chuyển ticket sang `In Review`, sửa theo góp ý | Đủ approve, mọi conversation đã resolve, CI pass |
| 8 | **Squash and merge** vào `main` | `main` có thêm đúng 1 commit |
| 9 | Chuyển ticket sang `Done`; khuyến khích xoá branch ở local và remote sau khi merge | Ticket đã đóng; branch merge rồi có thể xoá hoặc giữ lại |

---

## Bước 1: Nhận ticket trên Jira

Vòng đời status của một ticket:

```
Luồng chính:  To Do → In Progress → In Review → Done

Blocked:      Blocked → To Do                    (khi đã hết blocker)
Cancelled:    mọi status trừ Done → Cancelled    (khi ticket bị huỷ)
```

- Luồng chính là `To Do` → `In Progress` → `In Review` → `Done`. Phần lớn ticket đi thẳng luồng này, bắt đầu từ `To Do`.
- `Blocked`: dành cho ticket chưa làm được vì còn phụ thuộc ticket khác. Khi không còn blocker nào thì chuyển về `To Do` ([Bước 9](#bước-9-dọn-dẹp-và-đóng-ticket)).
- `Cancelled`: ticket bị huỷ, không làm nữa. Có thể chuyển sang `Cancelled` từ bất kỳ status nào **trừ** `Done`. PR tương ứng (nếu có) cũng đóng lại mà không merge.

Quy tắc:

- Mỗi phần công việc đều phải có **ticket trên Jira** trước khi bắt đầu code.
- Khi bắt đầu làm, tự assign ticket cho mình và chuyển status từ `To Do` → `In Progress`.
- Khi request review, chuyển sang `In Review` ([Bước 7](#bước-7-review)); khi PR đã merge, chuyển sang `Done` ([Bước 9](#bước-9-dọn-dẹp-và-đóng-ticket)).
- Nếu ticket có khối lượng công việc lớn, chủ động **tách thành nhiều ticket/branch nhỏ**. PR nhỏ giúp review nhanh và chính xác hơn, đồng thời hạn chế conflict.

---

## Bước 2: Tạo branch từ `main`

Luôn tách branch từ `main` **mới nhất**, không tách từ branch của người khác:

```bash
git checkout main
git pull origin main
git checkout -b CDA-12-add-user-login
```

### Quy tắc đặt tên branch

```
<ticket>-<mô-tả-ngắn-gọn>
```

| Thành phần | Mô tả |
|------------|-------|
| Ticket | Mã task trên Jira, ví dụ `CDA-2`, `CDA-12` |
| Mô tả ngắn gọn | Kebab-case, **viết bằng tiếng Anh**, mô tả công việc |

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
git commit -m "add login form"  # commit message viết bằng tiếng Anh
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

> **Lưu ý:** `git merge main` bị cấm trong quy trình của nhóm. Nếu lỡ tay merge, hãy gỡ commit merge ra rồi rebase lại. Riêng nút **Squash and merge** trên GitHub ở [Bước 8](#bước-8-merge) là cách merge PR duy nhất được dùng.

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

Điền đầy đủ [template PR](.github/pull_request_template.md): mô tả thay đổi, link ticket, loại thay đổi, cách kiểm thử, ảnh chụp màn hình (nếu có thay đổi giao diện) và checklist.

### Kích thước PR

Để đảm bảo chất lượng review và hạn chế tối đa xung đột code, nên **tách nhỏ PR** nhất có thể để reviewer dễ đọc, dễ hiểu.

### Tự review trước khi request review

**Bắt buộc: chủ PR phải tự review lại toàn bộ diff của mình trước khi chuyển PR sang Ready for review.** Đây không phải là bước hình thức - đây là điều kiện tiên quyết.

Mở tab **Files changed** và đọc lại từng dòng thay đổi như thể đang review code của người khác. Chủ PR phải **giải thích được mọi dòng trong diff**: dòng đó làm gì, tại sao cần có, tại sao làm theo cách đó.

Điều này áp dụng cho cả code do AI sinh ra: dùng AI hỗ trợ thì được, nhưng **không được để lại trong diff đoạn code mà mình chưa đọc kỹ và chưa hiểu**, kiểu thấy "chạy được" nên giữ lại.

### Draft và Ready for review

Reviewer chỉ bắt đầu review khi PR ở trạng thái **Ready for review**.

Trong lúc chưa tự review xong, để PR ở trạng thái **Draft** để tránh reviewer vào xem nhầm lúc chưa sẵn sàng.

PR cũng cần được chuyển **về lại Draft** trong quá trình review nếu chủ PR cần push commit khi chưa xử lý xong hết góp ý - xem [Bước 7](#bước-7-review).

---

## Bước 7: Review

### Điều kiện request review

Chỉ được request review khi PR đã thoả **cả hai** điều kiện sau:

- **CI pass toàn bộ.** Không request review khi còn check đỏ - reviewer không phải người đi sửa lint hay test hộ.
- **Branch đã up to date với `main`.** Rebase `main` mới nhất vào branch và xử lý hết conflict trước ([Bước 5](#bước-5-đồng-bộ-với-main)), để reviewer đọc đúng phần diff thuộc về PR này chứ không lẫn thay đổi của người khác.

Nếu trong lúc chờ review mà `main` đã tiến lên hoặc CI chuyển sang đỏ, chủ PR chủ động rebase và sửa cho xanh lại, không để reviewer phải chờ.

### Khi request review

Ngay khi PR chuyển sang **Ready for review** và đã request reviewer, chủ PR phải chuyển status ticket trên Jira từ `In Progress` → `In Review`. Nhìn vào board là biết ticket nào đang chờ người khác xem.

Ticket ở lại `In Review` trong suốt quá trình review, kể cả khi đang sửa theo góp ý, chỉ rời trạng thái này khi PR được merge vào `main` (→ `Done`) hoặc PR bị huỷ bỏ (→ `Cancelled`).

### Với chủ PR

- Chủ động **request reviewer** ngay khi PR chuyển sang **Ready for review**, không chờ người khác tự vào xem.
- Trả lời **mọi** comment của reviewer; sửa xong thì push commit mới lên cùng branch (không cần tạo PR mới).
- Nếu không đồng ý với góp ý, trao đổi trực tiếp trong PR thay vì im lặng bỏ qua.
- Tuân thủ quy ước về [resolve conversation](#resolve-conversation) và [push commit mới](#push-commit-mới-lên-pr-đang-chờ-review) ở dưới.

### Với reviewer

- Chủ động **sắp xếp thời gian review sớm nhất có thể** ngay khi được request, để branch không bị giữ lâu, đúng tinh thần short-lived branch và giúp PR được merge sớm.
- Để lại comment cụ thể, gắn với dòng code cần góp ý.
- Chỉ approve khi đã hiểu rõ chủ PR đang làm gì và đồng ý với thay đổi cũng như hướng triển khai đó.
- Chỉ được **comment và approve**, **không tự ý merge** PR - merge là việc của chủ PR (xem [Bước 8](#bước-8-merge)).

### Resolve conversation

Nút **Resolve conversation** đánh dấu một luồng comment đã được xử lý xong. Quy ước của nhóm:

- **Chỉ reviewer - người để lại comment - mới được bấm Resolve conversation.** Chủ PR không tự resolve comment của người khác.
- Chủ PR sửa xong thì **reply ngay dưới comment đó** để reviewer biết (ví dụ: `done in a1b2c3d`, hoặc mô tả ngắn cách đã xử lý).
- Nếu không đồng ý với góp ý, chủ PR reply nêu rõ lý do và **để nguyên thread mở** cho tới khi hai bên thống nhất.
- Reviewer khi quay lại xem: thread nào đã đồng ý với cách xử lý thì bấm resolve, thread nào chưa ổn thì reply tiếp.

Mỗi comment chưa resolve đều phải ở một trong hai trạng thái rõ ràng: **đã có commit sửa** hoặc **đã có reply của chủ PR**. Không để comment nào bị bỏ trống, không hồi đáp.

### Push commit mới lên PR đang chờ review

Trước khi push commit mới lên PR đang ở trạng thái **Ready for review**, chủ PR phải chắc chắn **mọi comment chưa resolve đều đã được xử lý** - tức là đã có commit sửa tương ứng, hoặc đã có reply nêu lý do không sửa.

Trước khi push, nên tranh thủ rebase với `main` nếu branch đã bị outdated, để các commit mới được cập nhật trên nền `main` mới nhất.

Nếu chưa xử lý xong mà vẫn cần push (lưu tạm công việc dở dang, còn đang sửa tiếp nhiều chỗ), hãy **chuyển PR về Draft trước khi push**. Xong hết thì chuyển lại **Ready for review** và **request review lại** bằng nút 🔄 cạnh tên reviewer hoặc nhắn trực tiếp cho reviewer để nhờ review lại.

Mục đích: mỗi lần reviewer được gọi vào là một lần PR thực sự sẵn sàng để xem, tránh việc reviewer phải đọc đi đọc lại một PR đang thay đổi liên tục.

---

## Bước 8: Merge

### Điều kiện merge

- **Tất cả** thành viên cùng phụ trách task phải approve. Nếu có thành viên khác (không trực tiếp phụ trách task) chủ động yêu cầu được review, cũng phải đợi người đó approve mới được merge.
- **Tất cả conversation trên PR phải được resolve** (xem [Bước 7](#bước-7-review)).
- CI pass toàn bộ. Repo hiện có các check **PR title, Biome, import alias, typecheck, test và build**.
- Nhánh phải được **rebase lên `main` mới nhất** trước khi merge (xem [Bước 5](#bước-5-đồng-bộ-với-main)).

### Ai được merge

- **Chỉ chủ PR** mới được nhấn nút merge trên GitHub.
- Reviewer chỉ **comment và approve**, không tự ý merge PR của người khác, kể cả khi đã đủ điều kiện merge ở trên.

### Cách merge

- Bắt buộc dùng **Squash and merge** - gộp nhiều commit nhỏ thành **một commit** cho thống nhất và gọn gàng.
- Commit message sau squash = **đúng tiêu đề PR**, không giữ lại phần liệt kê danh sách các commit lẻ mà GitHub tự động điền vào ô message. Trước khi bấm **Confirm squash and merge**, xoá hết phần nội dung (body) đó, chỉ để lại dòng tiêu đề.

---

## Bước 9: Dọn dẹp và đóng ticket

Sau khi PR đã merge, branch coi như xong nhiệm vụ. Khuyến khích xoá cho gọn, nhưng không bắt buộc.

Xoá branch ở remote: nhấn nút **Delete branch** ngay trên PR đã merge.

Xoá branch ở local:

```bash
git checkout main
git pull origin main
git branch -D CDA-12-add-user-login    # xoá branch ở local
```

> **Vì sao là `-D` chứ không phải `-d`:** nhóm dùng **Squash and merge**, GitHub tạo ra một commit hoàn toàn mới trên `main` chứ không giữ lại các commit của branch. Git vì thế không nhận ra branch đã được merge và `git branch -d` sẽ báo `error: the branch '...' is not fully merged`. Chỉ dùng `-D` sau khi đã chắc chắn PR đã merge thành công.

Cuối cùng, chuyển ticket trên Jira từ `In Review` → `Done`.

Nếu ticket vừa xong đang **block** ticket khác:

- Chỉ chuyển **ticket đang bị block** từ `Blocked` → `To Do` khi nó không còn blocker nào khác.
- Khi ticket đó chuyển được sang `To Do`, báo ngay cho người đảm nhận (assignee) để họ có thể bắt tay vào làm.

---
