@echo off
echo ==============================================
echo CERRANDO SESION DEL BOT DE BUEN PLAN...
echo ==============================================
echo.
echo Borrando datos de sesion antiguos...
if exist "auth_info_baileys" (
    rmdir /s /q "auth_info_baileys"
    echo [EXITO] Sesion cerrada correctamente.
) else (
    echo [INFO] No habia ninguna sesion iniciada.
)
echo.
echo La proxima vez que inicies el bot te pedira escanear un nuevo QR.
echo Presiona cualquier tecla para salir...
pause >nul
