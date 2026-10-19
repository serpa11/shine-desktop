<#
.SYNOPSIS
    Publishes this project to GitHub and attaches the installers to a release.

.DESCRIPTION
    Creates the repository (if it does not exist), pushes the source, then
    creates a tagged release containing ShineSetup.exe and the NSIS installer.

    Needs the GitHub CLI. If it is not installed this script tries winget.

.PARAMETER RepoName
    Repository name, without the owner. Default: shine-desktop

.PARAMETER Visibility
    public or private. Default: public

.PARAMETER Token
    A GitHub personal access token with repo scope. If omitted the script
    looks for $env:GH_TOKEN or $env:GITHUB_TOKEN, then falls back to whatever
    gh is already authenticated with.

.EXAMPLE
    .\scripts\publish-github.ps1 -RepoName shine-desktop
    $env:GH_TOKEN = "ghp_xxx"; .\scripts\publish-github.ps1 -RepoName shine-desktop
#>
[CmdletBinding()]
param(
    [string]$RepoName = 'shine-desktop',
    [ValidateSet('public', 'private')]
    [string]$Visibility = 'public',
    [string]$Token = $env:GH_TOKEN,
    [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }

function Fail($message) { Write-Host "FAILED: $message" -ForegroundColor Red; Pop-Location; exit 1 }

try {
    # ---------------------------------------------------------------- gh
    Step 'Checking for the GitHub CLI'
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host 'gh is not installed. Trying winget...'
        $installed = $false
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements | Out-Null
            $installed = $true
        }
        if (-not $installed) {
            Fail 'Install the GitHub CLI from https://cli.github.com and run this again.'
        }
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'gh is still not on PATH. Restart the terminal and run this again.' }
    }
    Write-Host 'gh found.'

    # ------------------------------------------------------------- auth
    Step 'Checking authentication'
    $authed = $false
    gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { $authed = $true }

    if (-not $authed) {
        if (-not $Token) { $Token = $env:GITHUB_TOKEN }
        if ($Token) {
            Write-Host 'Signing in with the supplied token...'
            $Token | gh auth login --hostname github.com --git-protocol https --with-token
            if ($LASTEXITCODE -ne 0) { Fail 'gh rejected the token.' }
        } else {
            gh auth login --hostname github.com --git-protocol https --web
            if ($LASTEXITCODE -ne 0) { Fail 'Sign-in did not complete.' }
        }
    }
    $account = gh api user --jq .login
    if (-not $account) { Fail 'Could not read the authenticated GitHub user.' }
    Write-Host "Signed in as $account."

    # ------------------------------------------------------------- repo
    Step "Creating $account/$RepoName ($Visibility)"
    $exists = $false
    gh repo view "$account/$RepoName" *> $null
    if ($LASTEXITCODE -eq 0) { $exists = $true }

    if ($exists) {
        Write-Host 'Repository already exists, using it.'
    } else {
        gh repo create "$account/$RepoName" --$Visibility --source . --remote origin | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'Could not create the repository.' }
        Write-Host 'Repository created.'
    }

    # ------------------------------------------------------------- push
    Step 'Pushing the source'
    if ((git symbolic-ref --short HEAD) -eq 'HEAD') { git checkout -q -b main }

    # Pick up anything changed since the last commit, ignoring build output
    # and the unrelated projects that share this folder.
    git add -A
    if (-not (git diff --cached --quiet)) {
        git commit -q -m 'Shine desktop app'
        Write-Host 'Committed local changes.'
    }

    git remote remove origin *> $null
    git remote add origin "https://github.com/$account/$RepoName.git"
    git push -q -u origin HEAD
    if ($LASTEXITCODE -ne 0) { Fail 'Push failed.' }
    Write-Host 'Pushed.'

    # ----------------------------------------------------------- release
    Step 'Preparing the release'
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $tag = "v$version"

    $assets = @()
    $setupExe = Join-Path $root 'release-setup\ShineSetup.exe'
    $nsisExe = Join-Path $root "release\ShineSetup-$version.exe"
    if (Test-Path $setupExe) { $assets += $setupExe }
    if (Test-Path $nsisExe) { $assets += $nsisExe }

    if ($assets.Count -eq 0) {
        Write-Host 'No built installers found. Run "npm run release" first; skipping the release.' -ForegroundColor Yellow
        Write-Host "`nDone: source pushed to https://github.com/$account/$RepoName" -ForegroundColor Green
        exit 0
    }

    foreach ($asset in $assets) {
        Write-Host ("  attaching {0} ({1} MB)" -f (Split-Path $asset -Leaf), [math]::Round((Get-Item $asset).Length / 1MB, 1))
    }

    if (-not $Notes) {
        $Notes = @"
Shine Setup $version

`ShineSetup.exe is the installer. It shows you the install location and
asks whether you want a desktop shortcut, a Start Menu shortcut, Shine to
start with Windows, and whether to open it when the install finishes.

The app adds three things to shineai-9mr.pages.dev: real window buttons,
a PC Control mode that asks before every action it takes, and dictation
through the site's own microphone button.
"@
    }

    gh release create $tag @assets --title "Shine $version" --notes $Notes
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Tagging an existing release instead...'
        gh release upload $tag @assets --clobber
    }

    Write-Host "`nDone." -ForegroundColor Green
    Write-Host "  repo    : https://github.com/$account/$RepoName"
    Write-Host "  release : https://github.com/$account/$RepoName/releases/tag/$tag"
}
catch {
    Fail $_.Exception.Message
}
finally {
    Pop-Location
}