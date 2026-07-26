# Hướng dẫn đóng góp

Tài liệu này quy định quy trình làm việc chung của nhóm, từ lúc nhận ticket trên Jira cho tới khi ticket được đóng.

Mọi thành viên đều phải tuân thủ quy trình này. 

## Mục lục

- [Mô hình phát triển: Trunk-Based Development (TBD)](#mô-hình-phát-triển-trunk-based-development-tbd)
- [Tổng quan quy trình](#tổng-quan-quy-trình)
- [Bước 1 — Nhận ticket trên Jira](#bước-1--nhận-ticket-trên-jira)
- [Bước 2 — Tạo branch từ `main`](#bước-2--tạo-branch-từ-main)
- [Bước 3 — Code và commit](#bước-3--code-và-commit)
- [Bước 4 — Đẩy branch lên remote](#bước-4--đẩy-branch-lên-remote)
- [Bước 5 — Đồng bộ với `main`](#bước-5--đồng-bộ-với-main)
- [Bước 6 — Mở Pull Request](#bước-6--mở-pull-request)
- [Bước 7 — Review](#bước-7--review)
- [Bước 8 — Merge](#bước-8--merge)
- [Bước 9 — Dọn dẹp và đóng ticket](#bước-9--dọn-dẹp-và-đóng-ticket)
- [Tham khảo thêm](#tham-khảo-thêm)

---

## Mô hình phát triển: Trunk-Based Development (TBD)

Nhóm áp dụng **Trunk-Based Development**: **trunk của repo là nhánh `main`** — thành viên làm việc trên các **short-lived branch** tách từ `main`, merge lại ngay sau khi hoàn thành.

- `main` luôn ở trạng thái **sẵn sàng release** tại mọi thời điểm.
- Nhóm có thể **demo trực tiếp từ `main`** tại bất kỳ thời điểm nào (cuối mỗi sprint/milestone) mà không cần branch riêng để "ổn định hóa" trước demo.
- Không commit trực tiếp lên `main` — mọi thay đổi đều đi qua Pull Request.

---

## Tổng quan quy trình

| Bước | Việc cần làm | Kết quả |
|------|--------------|---------|
| 1 | Nhận ticket trên Jira, chuyển `TO DO` → `In Progress` | Status của ticket là In Progress |
| 2 | Cập nhật `main`, tách branch mới | Branch ngắn hạn theo đúng quy ước tên |
| 3 | Code và commit | Các commit nhỏ (khuyến khích), message tiếng Anh |
| 4 | Push branch lên remote | Branch đã có trên GitHub |
| 5 | Rebase `main` mới nhất vào branch và xử lí hết conflict| Branch không còn lệch `main`, hết conflict |
| 6 | Mở Pull Request, tự review, chuyển **Ready for review** | PR đúng định dạng tiêu đề, đã điền template |
| 7 | Request review + chuyển ticket sang `In Review`, sửa theo góp ý | Đủ approve, CI pass |
| 8 | **Squash and merge** vào `main` | `main` có thêm đúng 1 commit |
| 9 | Xoá branch ở dưới local (nếu muốn), chuyển ticket sang `Done` | Repo và board sạch sẽ |

---

## Bước 1 — Nhận ticket trên Jira

Vòng đời status của một ticket:

```
TO DO → In Progress → In Review → Done
```

- Mỗi phần công việc đều phải có **ticket trên Jira** trước khi bắt đầu code.
- Khi bắt đầu làm, tự assign ticket cho mình và chuyển status từ `TO DO` → `In Progress`.
- Khi request review, chuyển sang `In Review` ([Bước 7](#bước-7--review)); khi PR đã merge, chuyển sang `Done` ([Bước 9](#bước-9--dọn-dẹp-và-đóng-ticket)).
- Nếu ticket có khối lượng công việc lớn, chủ động **tách thành nhiều ticket/branch nhỏ**. PR nhỏ giúp review nhanh và chính xác hơn, đồng thời hạn chế conflict.

---

## Bước 2 — Tạo branch từ `main`

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
- Branch phải **ngắn hạn** — merge vào `main` ngay khi xong, không giữ lâu.

---

## Bước 3 — Code và commit

```bash
git add <file>                  # stage từng file
git add .                       # stage toàn bộ thay đổi
git commit -m "add login form"  # commit message viết bằng tiếng Anh
```

### Quy tắc commit

- Commit message viết bằng **tiếng Anh**.
- Trên **nhánh riêng**, có thể commit bao nhiêu tùy thích — các commit sẽ được gộp lại khi squash merge.
- Commit theo từng phần việc nhỏ, tránh dồn toàn bộ thay đổi vào một commit khổng lồ (khuyến khích).
- **Không commit file nhạy cảm** (`.env`, key, mật khẩu, credentials) và file build/artifact.

---

## Bước 4 — Đẩy branch lên remote

```bash
git push -u origin CDA-12-add-user-login   # lần đầu tiên
git push                                   # các lần sau
```

Nên push sớm và push thường xuyên để công việc không nằm hết ở máy local.

---

## Bước 5 — Đồng bộ với `main`

Trước khi mở PR (và trước khi merge), branch phải được đồng bộ với `main` mới nhất. Nhóm **chỉ dùng `rebase`**, **không dùng `git merge`** để đồng bộ — mục đích là giữ lịch sử tuyến tính, sạch sẽ, không có commit merge rác trong branch:

Đứng ngay tại branch của mình và chạy:

```bash
git pull --rebase origin main
```

Sau khi rebase, lịch sử branch đã bị viết lại nên cần force push (chỉ dùng trên nhánh riêng của mình, **không bao giờ** dùng trên `main`):

```bash
git push --force-with-lease
```

> Dùng `--force-with-lease` thay vì `--force`: nếu có người khác vừa push lên cùng branch, lệnh sẽ dừng lại thay vì ghi đè mất commit của họ.

> **Lưu ý:** `git merge main` bị cấm trong quy trình của nhóm. Nếu lỡ tay merge, hãy gỡ commit merge ra rồi rebase lại. Riêng nút **Squash and merge** trên GitHub ở [Bước 8](#bước-8--merge) là cách merge PR duy nhất được dùng.

### Khi có conflict

Quy ước của nhóm: nếu conflict nằm ở phần code của người khác, hãy **liên hệ người đó để cùng xử lý**, hoặc tự xử lý rồi **nhờ họ review lại**, tránh làm sai logic có sẵn.

---

## Bước 6 — Mở Pull Request

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

### Draft và Ready for review

Để đảm bảo chất lượng review và hạn chế tối đa xung đột code, nên **tách nhỏ PR** nhất có thể để reviewer dễ đọc, dễ hiểu.

Reviewer chỉ bắt đầu review khi PR ở trạng thái **Ready for review** — nghĩa là chủ PR đã **tự review lại toàn bộ diff** của mình trước:

Trong lúc chưa tự review xong, để PR ở trạng thái **Draft** để tránh reviewer vào xem nhầm lúc chưa sẵn sàng.

---

## Bước 7 — Review

### Khi request review

Ngay khi PR chuyển sang **Ready for review** và đã request reviewer, chủ PR phải chuyển status ticket trên Jira từ `In Progress` → `In Review`. Nhìn vào board là biết ticket nào đang chờ người khác xem.

Ticket ở lại `In Review` trong suốt quá trình review, kể cả khi đang sửa theo góp ý, chỉ rời trạng thái này khi PR được merge vào main (→ `Done`) hoặc PR bị hủy bỏ (→ quay lại `CANCELLED`).

### Với chủ PR

- Trả lời mọi comment của reviewer; sửa xong thì push commit mới lên cùng branch (không cần tạo PR mới).
- Không tự resolve comment của reviewer khi chưa thống nhất.
- Nếu không đồng ý với góp ý, trao đổi trực tiếp trong PR thay vì im lặng bỏ qua.

### Với reviewer

- Review sớm nhất có thể để branch không bị giữ lâu, đúng tinh thần short-lived branch.
- Góp ý cụ thể vào dòng code.

---

## Bước 8 — Merge

### Điều kiện merge

- **Tất cả** thành viên cùng phụ trách task phải approve. Nếu có thành viên khác (không trực tiếp phụ trách task) chủ động yêu cầu được review, cũng phải đợi người đó approve mới được merge.
- CI pass toàn bộ. Hiện tại repo mới có check **PR title**; các check **lint, test, build** sẽ được bổ sung khi có source code.
- Nhánh phải được **rebase lên `main` mới nhất** trước khi merge (xem [Bước 5](#bước-5--đồng-bộ-với-main)).

### Cách merge

- Bắt buộc dùng **Squash and merge** — gộp nhiều commit nhỏ thành **một commit** cho thống nhất và gọn gàng.
- Commit message sau squash = tiêu đề PR.

---

## Bước 9 — Dọn dẹp và đóng ticket

```bash
git checkout main
git pull origin main
git branch -d CDA-12-add-user-login                # xoá branch ở local
```

Cuối cùng, chuyển ticket trên Jira từ `In Review` → `Done`.

---

