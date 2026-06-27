# GO REGISTER

Projeto separado em duas partes:

## Site

Arquivos em `site/`.

Para rodar:

```powershell
cd site
python -m http.server 5173
```

Acesse `http://localhost:5173`.

## Aplicativo Android

Arquivos do repositório/app Android em `mobile/`.

Dentro de `mobile/` a estrutura original do Android foi preservada: `app/`, `gradle/`, `gradlew`, `settings.gradle.kts`, etc.

Comandos uteis:

```powershell
cd mobile
.\gradlew.bat :app:assembleDebug
.\gradlew.bat :app:compileDebugKotlin
```
