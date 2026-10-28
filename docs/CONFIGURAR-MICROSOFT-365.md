# Configurar Microsoft 365 (Entra ID + Microsoft Graph)

Esta guía crea el **registro de aplicación** que la app usa para:

- el **login SSO** con cuentas de Office 365, y
- llamar a **Microsoft Graph** para crear las reuniones en Outlook (invitaciones automáticas), cancelarlas y buscar personas.

> **Quién lo hace:** alguien con rol **Administrador global** o **Administrador de aplicaciones** en el
> tenant de Microsoft 365. Solo un administrador global o de roles con privilegios puede dar el
> **consentimiento de administrador** (paso 6).
>
> **Requisito de los usuarios:** cada persona que reserve debe tener **licencia con Exchange Online**
> (buzón de correo). Sin buzón, Graph no puede crear el evento.

Al final tendrá 3 valores que se ingresan en la app (**Configuración → Microsoft 365 (SSO)**, como administrador):

| Campo en la app | De dónde sale |
|---|---|
| Id. de directorio (tenant) | Id. de directorio (inquilino), paso 3 |
| Id. de aplicación (cliente) | Id. de aplicación (cliente), paso 3 |
| Secreto de cliente (Valor) + fecha de vencimiento | **Valor** del secreto de cliente, paso 5 |

---

## Paso 1 — Entrar al portal

1. Abra **https://entra.microsoft.com** con la cuenta administradora.
2. Menú izquierdo: **Identidad → Aplicaciones → Registros de aplicaciones**.
   (En portal.azure.com es: **Microsoft Entra ID → Registros de aplicaciones**.)

## Paso 2 — Crear el registro

1. Clic en **+ Nuevo registro**.
2. Complete:
   - **Nombre:** `Reserva de Salas` (es lo que verán los usuarios al iniciar sesión).
   - **Tipos de cuenta compatibles:** *Solo cuentas de este directorio organizativo (inquilino único)*.
   - **URI de redirección:** plataforma **Web** →
     `http://localhost:3000/auth/callback`
3. Clic en **Registrar**.

> La URI debe coincidir **exactamente** con la que muestra la app en **Configuración → URI de redirección**
> (es `BASE_URL` del `.env` + `/auth/callback`)
> (mismo protocolo, dominio, puerto y sin barra final).

## Paso 3 — Copiar los identificadores

En la página **Información general** de la aplicación copie:

- **Id. de aplicación (cliente)**
- **Id. de directorio (inquilino)**

## Paso 4 — URIs de producción

**Autenticación → Configuraciones de plataforma → Web**:

1. **Agregar URI**: cuando tenga el dominio definitivo, agregue por ejemplo
   `https://salas.suempresa.cl/auth/callback`. Pueden convivir la de localhost y la de producción.
   Microsoft exige **https** para todo lo que no sea `localhost`.
2. **URL de cierre de sesión de canal frontal:** puede dejarla vacía.
3. **Concesión implícita y flujos híbridos:** deje **ambas casillas desmarcadas** (la app usa código de autorización + PKCE).
4. **Guardar**.

## Paso 5 — Crear el secreto de cliente

1. **Certificados y secretos → Secretos de cliente → + Nuevo secreto de cliente**.
2. Descripción: `app reservas`. Expiración: **24 meses** (o lo que dicte su política).
3. Clic en **Agregar** y copie de inmediato la columna **Valor** y anote la fecha de la columna **Expira**.

> ⚠ Copie el **Valor**, no el *Id. de secreto*. El valor solo se muestra una vez; si lo pierde, cree otro.
> Ingrese la fecha de vencimiento en la app: 30 días antes avisará a los administradores. Para renovarlo,
> cree un nuevo secreto aquí y péguelo en **Configuración** (no hay que tocar el `.env` ni reiniciar).

## Paso 6 — Permisos de Microsoft Graph (delegados) — **obligatorio**

1. **Permisos de API → + Agregar un permiso → Microsoft Graph → Permisos delegados**.
2. Busque y marque:

   | Permiso | Para qué |
   |---|---|
   | `openid`, `profile`, `email`, `offline_access` | Iniciar sesión y mantener la sesión sin volver a pedir clave |
   | `User.Read` (viene por defecto) | Leer nombre y correo del usuario |
   | `User.ReadBasic.All` | Buscar compañeros para invitarlos |
   | `Calendars.ReadWrite` | Crear/cancelar la reunión en el calendario del usuario (Outlook envía las invitaciones) |
   | `Mail.Send` *(recomendado)* | Enviar a quien reserva un correo de confirmación. Outlook **no** envía la invitación al organizador, solo a los asistentes. Luego active **Configuración → Enviar correo de confirmación a quien reserva**. |

3. **Agregar permisos**.
4. Clic en **✓ Conceder consentimiento de administrador para <su organización>** → **Sí**.
5. Verifique que todos queden con **marca verde "Concedido para..."**.

Con esto ya funciona: login SSO, búsqueda de personas, creación de reservas con invitación y cancelación
de las propias reservas.

## Paso 7 — Permisos de aplicación — *opcional*

Solo si quiere que el **administrador** de la app pueda:
- cancelar reservas de otros **avisando a los invitados** por Outlook,
- buscar personas, y
- crear reservas (requiere además el paso 8).

1. **Permisos de API → + Agregar un permiso → Microsoft Graph → Permisos de aplicación**.
2. Marque `Calendars.ReadWrite` y `User.Read.All` → **Agregar permisos**.
3. **Conceder consentimiento de administrador** nuevamente.
4. En la app → **Configuración**: marque **Se otorgaron permisos de aplicación** y guarde.

> 🔒 `Calendars.ReadWrite` de **aplicación** permite a la app acceder a los calendarios de **todos** los
> buzones del tenant. Si su área de seguridad lo exige, puede limitarlo con
> **RBAC para aplicaciones de Exchange Online** a un grupo de buzones
> (https://learn.microsoft.com/exchange/permissions-exo/application-rbac). Tenga en cuenta que el admin
> solo podrá cancelar reuniones de organizadores incluidos en ese alcance.

## Paso 8 — Buzón para reservas del administrador — *opcional*

El usuario administrador de la app no tiene correo de Office 365, así que para que **cree** reservas
necesita un buzón desde donde salgan las invitaciones:

1. **Centro de administración de Exchange** (https://admin.exchange.microsoft.com) →
   **Destinatarios → Buzones → Agregar un buzón compartido**.
2. Nombre: `Reservas de Salas`, correo: por ejemplo `reservas@suempresa.cl`.
3. En la app → **Configuración** → **Buzón organizador**: `reservas@suempresa.cl` (requiere el paso 7).

## Paso 9 — Sala como recurso de Exchange — *opcional, recomendado*

Si crea la sala como **buzón de recurso**, también aparecerá ocupada en Outlook (Buscador de salas):

1. Centro de administración de Exchange → **Destinatarios → Recursos → Agregar un buzón de recurso** → tipo **Sala**.
2. Copie su correo (ej. `sala.reuniones@suempresa.cl`).
3. En la app, entre como administrador → **Administrar salas → Editar** → campo
   **Correo del recurso en Exchange**.

## Paso 10 — Ingresar los valores en la app y probar

1. Entre a la app como administrador → **Configuración → Microsoft 365 (SSO)**.
2. Pegue Id. de directorio, Id. de aplicación, secreto (Valor) y su fecha de vencimiento.
   Pulse **Probar conexión** y luego **Guardar** (la app no guarda credenciales que Microsoft rechace).
3. Abra la app → **Iniciar sesión con Microsoft 365**.
4. Cree una reserva invitando a un compañero y verifique que a ambos les llegue la invitación en Outlook.

---

## Errores frecuentes

| Error | Causa / solución |
|---|---|
| `AADSTS50011` *redirect URI mismatch* | La URI del paso 2/4 no es idéntica a `BASE_URL/auth/callback`. Revise http/https, puerto y barra final. |
| `AADSTS7000215` *invalid client secret* | Se copió el *Id. de secreto* en vez del **Valor**, o el secreto expiró. Cree uno nuevo. |
| `AADSTS65001` / pantalla de consentimiento | Falta **Conceder consentimiento de administrador** (paso 6). |
| `AADSTS700016` *application not found* | Id. de aplicación o Id. de directorio incorrectos en Configuración. |
| "Error al comunicarse con Microsoft 365" al reservar | El usuario no tiene buzón/licencia de Exchange Online, o falta el permiso `Calendars.ReadWrite`. Revise `docker compose logs app`. |
| La búsqueda de invitados no devuelve nada | Falta `User.ReadBasic.All` con consentimiento. Igual puede escribir el correo y pulsar **Agregar**. |
