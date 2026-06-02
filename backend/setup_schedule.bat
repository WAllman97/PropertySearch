@echo off
REM Schedule property alerts to run daily at 8:00 AM
setlocal enabledelayedexpansion

set SCRIPT_DIR=C:\Users\wallman_cau\Caius Capital LLP\Team - Team\Will A\Python\Rightmove-alerts\rightmove-alerts
set BAT_FILE=%SCRIPT_DIR%\run_property_alerts.bat
set PYTHON_EXE=C:\Users\wallman_cau\AppData\Local\Programs\Python\Python313\python.exe
set LOG_FILE=%SCRIPT_DIR%\property_alerts.log

REM Create the scheduled task to run daily at 8:00 AM
schtasks /create /tn "PropertyAlerts_Daily" /tr "%BAT_FILE%" /sc daily /st 08:00 /ru SYSTEM /f

echo Task created: PropertyAlerts_Daily will run daily at 8:00 AM
echo Run logs will be saved to: %SCRIPT_DIR%
pause
