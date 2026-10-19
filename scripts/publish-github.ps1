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

<#
    gh and git write progress, warnings and ordinary "not found" messages to
    stderr. With $ErrorActionPreference = 'Stop' PowerShell promotes those to
    terminating errors, so a routine check like `gh repo view` on a repo that
    does not exist yet would abort the whole script.

    Native commands are therefore run with the preference relaxed, and success
    is judged by exit code instead - which is what the caller was checking all
    along.
#>
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [switch]$ShowOutput
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @Arguments 2>&1
    } finally {
        $ErrorActionPreference = $previous
    }

    $script:NativeExit = $LASTEXITCODE
    $script:NativeOutput = @($output)

    if ($ShowOutput) {
        foreach ($line in $script:NativeOutput) {
            Write-Host ("  " + ($line | Out-String).TrimEnd())
        }
    }
}

# -ShowOutput is declared on each wrapper as well as on Invoke-Native. Without
# it here, ValueFromRemainingArguments would swallow it and hand "-ShowOutput"
# to gh as if it were one of its own flags.
function Invoke-Gh {
    param(
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments,
        [switch]$ShowOutput
    )
    Invoke-Native -FilePath 'gh' -Arguments $Arguments -ShowOutput:$ShowOutput
}

function Invoke-Git {
    param(
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments,
        [switch]$ShowOutput
    )
    Invoke-Native -FilePath 'git' -Arguments $Arguments -ShowOutput:$ShowOutput
}

# Convenience readers for the last Invoke-Native result.
function ExitCode { $script:NativeExit }
function OutputText { ($script:NativeOutput | Out-String).Trim() }

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
    Invoke-Gh auth status
    $authed = (ExitCode) -eq 0

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

    Invoke-Gh api user '--jq' '.login'
    if ((ExitCode) -ne 0) { Fail 'Could not read the authenticated GitHub user.' }
    $account = OutputText
    if (-not $account) { Fail 'Could not read the authenticated GitHub user.' }
    Write-Host "Signed in as $account."

    # ------------------------------------------------------------- repo
    Step "Creating $account/$RepoName ($Visibility)"
    Invoke-Gh repo view "$account/$RepoName"
    $exists = (ExitCode) -eq 0

    if ($exists) {
        Write-Host 'Repository already exists, using it.'
    } else {
        Invoke-Gh repo create "$account/$RepoName" "--$Visibility" '--source' '.' '--remote' 'origin'
        if ((ExitCode) -ne 0) { Fail "Could not create the repository. gh said: $(OutputText)" }
        Write-Host 'Repository created.'
    }

    # ------------------------------------------------------------- push
    Step 'Pushing the source'
    Invoke-Git symbolic-ref '--short' 'HEAD'
    if ((ExitCode) -ne 0 -or (OutputText) -eq 'HEAD') { Invoke-Git checkout '-q' '-b' 'main' }

    # Pick up anything changed since the last commit, ignoring build output
    # and the unrelated projects that share this folder.
    Invoke-Git add '-A'
    if ((ExitCode) -ne 0) { Fail 'git add failed.' }

    # --quiet exits 1 when there is something staged.
    Invoke-Git diff '--cached' '--quiet'
    if ((ExitCode) -ne 0) {
        Invoke-Git commit '-q' '-m' 'Shine desktop app'
        if ((ExitCode) -ne 0) { Fail 'git commit failed.' }
        Write-Host 'Committed local changes.'
    } else {
        Write-Host 'Nothing new to commit.'
    }

    Invoke-Git remote 'remove' 'origin'
    Invoke-Git remote 'add' 'origin' "https://github.com/$account/$RepoName.git"
    Invoke-Git push '-q' '-u' 'origin' 'HEAD'
    if ((ExitCode) -ne 0) { Fail "Push failed. git said: $(OutputText)" }
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

ShineSetup.exe is the installer. It shows you the install location and asks whether you want a desktop shortcut, a Start Menu shortcut, Shine to start with Windows, and whether to open it when the install finishes.

The app adds three things to shineai-9mr.pages.dev: real window buttons, a PC Control mode that asks before every action it takes, and dictation through the site's own microphone button.
"@
    }

    Invoke-Gh release create $tag @assets '--title' "Shine $version" '--notes' $Notes -ShowOutput
    if ((ExitCode) -ne 0) {
        Write-Host 'Tagging an existing release instead...'
        Invoke-Gh release upload $tag @assets '--clobber' -ShowOutput
        if ((ExitCode) -ne 0) { Fail "Could not attach the installers. gh said: $(OutputText)" }
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
