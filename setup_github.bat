@echo off
echo ===========================================
echo   SIPAL AIRDROP - SAT SET GITHUB UPLOAD
echo ===========================================
echo.

:: 1. Initialize
if not exist .git (
    echo [+] Menginisialisasi Git...
    git init
    git branch -M main
)

:: 1.5 Configure Identity (If missing)
git config user.email >nul 2>&1
git config user.email >nul 2>&1
if %errorlevel% equ 0 goto check_git_done

echo.
echo [!] Git belum kenal Anda (Identity Unknown).
echo Silakan masukkan Nama & Email untuk konfigurasi awal.
echo.
set /p git_name="Nama Anda: "
set /p git_email="Email Anda: "

git config --global user.name "%git_name%"
git config --global user.email "%git_email%"
echo [+] Identitas tersimpan!
echo.

:check_git_done

:: 2. Add & Commit
echo [+] Menambahkan file ke stage...
git add .
echo [+] Membuat commit...
git commit -m "Sipal Bot Update V1.0"

:: 3. Remote Setup
echo.
echo Masukkan Link Repository GitHub (misal: https://github.com/user/repo.git)
set /p repo_url="Link Repo: "

if "%repo_url%"=="" goto error

echo [+] Menghubungkan ke %repo_url%...
git remote remove origin 2>nul
git remote add origin %repo_url%

:: 4. Push
echo [+] Mengupload ke GitHub...
git push -u origin main

echo.
echo [SUCCESS] Bot berhasil diupload! Sat Set Wat Wet!
pause
exit

:error
echo [ERROR] Link repo tidak boleh kosong!
pause
