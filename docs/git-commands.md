# Các lệnh Git thường dùng

Tài liệu tra cứu nhanh các lệnh Git hay dùng trong nhóm, kèm quy trình chuẩn từ lúc nhận ticket đến khi PR được merge. Quy ước đặt tên branch, tiêu đề PR và điều kiện merge xem tại [`CONTRIBUTING.md`](../CONTRIBUTING.md).

Trunk của repo là nhánh `main`.

---

## Quy trình chuẩn: từ nhận ticket đến khi merge

### 1. Cập nhật trunk và tạo branch mới

Luôn tách branch từ `main` mới nhất, không tách từ branch của người khác.

```bash
git checkout main
git pull origin main
git checkout -b CDA-12-add-user-login
```

### 2. Làm việc và commit

```bash
git status                      # xem file nào đã thay đổi
git diff                        # xem nội dung thay đổi chưa stage
git add <file>                  # stage từng file (khuyến khích)
git add .                       # stage toàn bộ thay đổi
git commit -m "add login form"  # commit message viết bằng tiếng Anh
```

Trên nhánh riêng có thể commit thoải mái — các commit sẽ được gộp lại khi squash merge.

### 3. Đẩy branch lên remote

```bash
git push -u origin CDA-12-add-user-login   # lần đầu tiên
git push                                    # các lần sau
```

### 4. Đồng bộ với trunk trước khi mở PR

Ưu tiên `rebase` để giữ lịch sử sạch:

```bash
git checkout main
git pull origin main
git checkout CDA-12-add-user-login
git rebase main
```

Nếu có conflict, xem phần [Xử lý conflict](#xử-lý-conflict) bên dưới.

Sau khi rebase, lịch sử branch đã bị viết lại nên cần force push (chỉ dùng trên nhánh riêng của mình, **không bao giờ** dùng trên `main`):

```bash
git push --force-with-lease
```

> Dùng `--force-with-lease` thay vì `--force`: nếu có người khác vừa push lên cùng branch, lệnh sẽ dừng lại thay vì ghi đè mất commit của họ.

### 5. Mở Pull Request

```bash
gh pr create --fill               # tạo PR, tự điền từ commit
gh pr create --web                # mở trình duyệt để điền template
gh pr view --web                  # mở PR hiện tại trên trình duyệt
gh pr status                      # xem trạng thái các PR của mình
gh pr checks                      # xem kết quả CI
```

Tiêu đề PR phải đúng định dạng `<ticket> <type>: <mô tả>`, ví dụ `CDA-12 feat: add user login` — nếu sai, CI `PR Title Lint` sẽ fail.

### 6. Sau khi merge — dọn dẹp

```bash
git checkout main
git pull origin main
git branch -d CDA-12-add-user-login          # xoá branch ở local
git push origin --delete CDA-12-add-user-login   # xoá branch trên remote (nếu chưa tự xoá)
git fetch --prune                             # dọn các remote branch đã bị xoá
```

---

## Tra cứu nhanh theo nhóm

### Xem thông tin

```bash
git status                       # trạng thái working tree
git log --oneline -10            # 10 commit gần nhất, mỗi commit 1 dòng
git log --oneline main..HEAD     # các commit của branch hiện tại so với trunk
git diff                         # thay đổi chưa stage
git diff --staged                # thay đổi đã stage
git diff main...HEAD             # toàn bộ diff của branch so với trunk
git diff --stat main...HEAD      # tóm tắt số file/dòng thay đổi
git show <commit>                # xem chi tiết một commit
git branch                       # danh sách branch local
git branch -a                    # gồm cả branch trên remote
```

> Nên chạy `git diff main...HEAD` để tự review lại toàn bộ thay đổi trước khi chuyển PR sang **Ready for review**.

### Chuyển branch

```bash
git checkout <branch>            # chuyển sang branch có sẵn
git checkout -b <branch>         # tạo branch mới và chuyển sang
git checkout -                   # quay lại branch vừa rời khỏi
```

### Hoàn tác

```bash
git restore <file>               # bỏ thay đổi chưa stage của 1 file
git restore --staged <file>      # bỏ stage, giữ nguyên nội dung thay đổi
git commit --amend               # sửa lại commit gần nhất (nội dung hoặc message)
git reset --soft HEAD~1          # gỡ commit gần nhất, giữ thay đổi ở vùng staged
git reset --mixed HEAD~1         # gỡ commit gần nhất, giữ thay đổi ở working tree
git revert <commit>              # tạo commit mới đảo ngược commit cũ (an toàn cho trunk)
```

> `reset` viết lại lịch sử — chỉ dùng cho commit **chưa push**. Với commit đã có trên trunk, dùng `revert`.

### Cất tạm thay đổi (stash)

Dùng khi đang làm dở mà cần chuyển branch gấp:

```bash
git stash                        # cất tạm thay đổi
git stash -u                     # cất tạm cả file mới chưa được track
git stash list                   # xem danh sách đã cất
git stash pop                    # lấy lại và xoá khỏi danh sách
git stash drop                   # xoá bản cất tạm mà không dùng
```

### Lấy commit lẻ từ branch khác

```bash
git cherry-pick <commit>         # áp dụng 1 commit từ branch khác vào branch hiện tại
```

---

## Xử lý conflict

Khi `rebase` hoặc `merge` báo conflict:

```bash
git status                       # xem file nào đang conflict
```

1. Mở từng file conflict, tìm các dấu `<<<<<<<`, `=======`, `>>>>>>>` và chỉnh lại nội dung cho đúng.
2. Xoá hết các dấu đánh dấu conflict.
3. Stage file đã xử lý xong và tiếp tục:

```bash
git add <file>
git rebase --continue            # nếu đang rebase
git merge --continue             # nếu đang merge
```

Muốn huỷ giữa chừng và quay về trạng thái trước đó:

```bash
git rebase --abort
git merge --abort
```

> Theo quy ước của nhóm: nếu conflict nằm ở phần code của người khác, hãy liên hệ người đó để cùng xử lý, hoặc tự xử lý rồi nhờ họ review lại — tránh làm sai logic có sẵn.

---

## Khi lỡ tay

```bash
git reflog                       # lịch sử mọi lần HEAD thay đổi
git reset --hard <commit>        # quay về đúng trạng thái của một commit
```

`git reflog` là cách lấy lại commit tưởng như đã mất sau `reset`, `rebase` hay xoá nhầm branch: tìm commit hash trong reflog rồi `git checkout` hoặc `git reset --hard` về đó.

> `git reset --hard` **xoá vĩnh viễn** mọi thay đổi chưa commit. Chạy `git status` kiểm tra trước khi dùng.

---

## Cấu hình lần đầu

```bash
git config --global user.name "Ho Ten"
git config --global user.email "email@example.com"
git config --global pull.rebase true      # mặc định dùng rebase khi pull
git config --global init.defaultBranch main
```
