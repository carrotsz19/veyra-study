<#
.SYNOPSIS
    Restores Veyra Study to the pre-UI-fixes backup branch (backup/pre-ui-fixes-2026-11-19).
.DESCRIPTION
    Shows all commits, changed files, and uncommitted changes that will be overwritten
    or left behind, asks for explicit confirmation, and then restores the working tree
    and 'main' branch to backup/pre-ui-fixes-2026-11-19 without deleting the backup branch.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
$BackupBranch = 'backup/pre-ui-fixes-2026-11-19'
$TargetBranch = 'main'

Push-Location $RepoRoot
try {
    # Verify git repo and backup branch exist
    $isGit = git rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -ne 0 -or $isGit -ne 'true') {
        Write-Error "Not a git repository: $RepoRoot"
        exit 1
    }

    $backupSha = git rev-parse --verify --short $BackupBranch 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $backupSha) {
        Write-Error "Backup branch '$BackupBranch' was not found in this repository."
        exit 1
    }

    $currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
    $currentSha = (git rev-parse --short HEAD).Trim()

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  Veyra Study - Restore Backup ($BackupBranch)" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "Repository     : $RepoRoot"
    Write-Host "Current branch : $currentBranch ($currentSha)"
    Write-Host "Backup branch  : $BackupBranch ($backupSha)  [will be kept]"
    Write-Host ""

    $statusLines = git status --short
    if ($statusLines) {
        Write-Host "Uncommitted changes that WILL BE DISCARDED:" -ForegroundColor Yellow
        $statusLines | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
        Write-Host ""
    } else {
        Write-Host "Uncommitted changes: none" -ForegroundColor DarkGray
        Write-Host ""
    }

    $commits = git log --oneline "$BackupBranch..HEAD"
    if ($commits) {
        Write-Host "Commits on '$currentBranch' not in '$BackupBranch':" -ForegroundColor Yellow
        $commits | ForEach-Object { Write-Host "  $_" }
        Write-Host ""
    }

    $diffStat = git diff --stat "$BackupBranch..HEAD"
    if ($diffStat) {
        Write-Host "Files that differ from '$BackupBranch' (will be reverted):" -ForegroundColor Yellow
        $diffStat | ForEach-Object { Write-Host "  $_" }
        Write-Host ""
    } else {
        Write-Host "Committed file differences from '$BackupBranch': none" -ForegroundColor DarkGray
        Write-Host ""
    }

    Write-Host "What this script will do:" -ForegroundColor White
    Write-Host "  1. Discard any uncommitted changes to tracked files (git reset --hard HEAD)."
    Write-Host "  2. Switch to '$TargetBranch' and align it with '$BackupBranch' ($backupSha)."
    Write-Host "  3. Keep '$BackupBranch' intact (the backup will NOT be deleted)."
    Write-Host "  Note: Your feature branch ('$currentBranch') will remain in git unless you delete it yourself."
    Write-Host ""

    $reply = Read-Host "Type YES to restore the backup, or press Enter to cancel"
    if ($reply -cne 'YES') {
        Write-Host "Cancelled. No changes were made." -ForegroundColor Green
        exit 0
    }

    Write-Host ""
    Write-Host "Restoring backup..." -ForegroundColor Cyan
    git reset --hard HEAD | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git reset --hard HEAD failed." }

    git checkout $TargetBranch
    if ($LASTEXITCODE -ne 0) { throw "git checkout $TargetBranch failed." }

    git reset --hard $BackupBranch
    if ($LASTEXITCODE -ne 0) { throw "git reset --hard $BackupBranch failed." }

    $restoredSha = (git rev-parse --short HEAD).Trim()
    Write-Host ""
    Write-Host "Restored '$TargetBranch' to $BackupBranch ($restoredSha)." -ForegroundColor Green
    Write-Host "Backup branch '$BackupBranch' is still preserved." -ForegroundColor Green
    Write-Host ""
} finally {
    Pop-Location
}
