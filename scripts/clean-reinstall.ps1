# Clean reinstall script for homey-edgetool-vscode
# This script removes package-lock.json, node_modules, and dist, then reinstalls dependencies and rebuilds.

Write-Host "Starting clean reinstall process..."

# 1. Remove package-lock.json if it exists
Remove-Item -Path "package-lock.json" -ErrorAction SilentlyContinue
Write-Host "Removed package-lock.json (if existed)"

# 2. Remove node_modules directory
Remove-Item -Path "node_modules" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Removed node_modules directory"

# 3. Remove dist directory (build artifacts)
Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Removed dist directory"

# 4. Reinstall dependencies
Write-Host "Running npm install..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
Write-Host "npm install completed successfully"

# 5. Run build
Write-Host "Running npm run build..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm run build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
Write-Host "Build completed successfully"

Write-Host "Clean reinstall process finished."
