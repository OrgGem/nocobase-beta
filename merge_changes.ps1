# merge_changes.ps1
# Script to merge all changes in packages/plugins and docker/production-ha (including untracked files) to the local main branch.

$ErrorActionPreference = "Stop"

try {
    # 1. Get current branch name
    $currentBranch = (git symbolic-ref --short HEAD).Trim()
    if ($currentBranch -eq "main") {
        Write-Error "You are already on the 'main' branch. Switch to the branch containing your changes first."
        exit 1
    }
    Write-Host "Current branch: $currentBranch" -ForegroundColor Green

    # 2. Stage all changes in target directories
    Write-Host "Staging changes in packages/plugins and docker/production-ha..." -ForegroundColor Cyan
    git add packages/plugins
    git add docker/production-ha

    # 3. Create a temporary commit (allow empty in case everything is already committed)
    Write-Host "Creating temporary commit..." -ForegroundColor Cyan
    git commit --allow-empty -m "temp: packages/plugins and docker/production-ha changes"

    # 4. Checkout main branch
    Write-Host "Switching to main branch..." -ForegroundColor Cyan
    git checkout main

    # 5. Bring changes from the source branch for the specific directories
    Write-Host "Checking out changes from $currentBranch..." -ForegroundColor Cyan
    git checkout $currentBranch -- packages/plugins docker/production-ha

    # 6. Commit changes to main
    Write-Host "Committing changes to main..." -ForegroundColor Cyan
    # Check if there is anything staged to commit
    $staged = git status --porcelain
    if ($staged) {
        git commit -m "merge: packages/plugins and docker/production-ha from $currentBranch"
        Write-Host "Changes successfully merged and committed to main!" -ForegroundColor Green
    } else {
        Write-Host "No changes detected to merge into main." -ForegroundColor Yellow
    }

    # 7. Switch back to original branch
    Write-Host "Switching back to $currentBranch..." -ForegroundColor Cyan
    git checkout $currentBranch

    # 8. Reset the temporary commit to restore original working tree and stage state
    Write-Host "Restoring original branch state..." -ForegroundColor Cyan
    git reset HEAD~1

    Write-Host "All done! Successfully merged specific folders to main, and restored $currentBranch to its original state." -ForegroundColor Green
}
catch {
    Write-Error "An error occurred during execution: $_"
    # Ensure we try to return to original branch if possible
    if ($currentBranch -and (git symbolic-ref --short HEAD) -ne $currentBranch) {
        Write-Host "Attempting to switch back to $currentBranch..." -ForegroundColor Yellow
        git checkout $currentBranch
    }
}
