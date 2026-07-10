# Messengly V1.1 — Product Specification

> Source: Notion V1.1 — https://www.notion.so/32ff92f5922e81e6ab5debf65993c43e

## Суть проекта

Омниканальный мессенджер — единое окно для управления коммуникациями через **Telegram**, **Slack**, **WhatsApp** и **Gmail**. Пользователь видит все чаты из всех подключённых каналов, может отвечать прямо из интерфейса, видит полную историю переписки и может создавать массовые рассылки.

**Ключевой принцип:** все исходящие сообщения отправляются от имени пользователя (не бота). Получатель видит сообщение как обычное личное сообщение.

**Бизнес-модель (SaaS):** Суперадмин — владелец платформы. Клиенты (компании) покупают продукт, Суперадмин разворачивает для них отдельное окружение (организацию), приглашает Администратора компании, который далее самостоятельно настраивает свою организацию и приглашает своих пользователей.

**Принцип работы с чатами:** чаты не появляются автоматически. Пользователь или Админ явно импортирует (добавляет) нужные чаты из подключённых мессенджеров в систему. После импорта чаты хранятся на уровне организации и не исчезают при отключении/переподключении интеграции.

**Пример use-case:** пользователь создаёт 1 рассылку → выбирает 50 чатов (Telegram, Slack, WhatsApp, Gmail вперемешку) → сообщение уходит во все чаты от имени пользователя.

---

## Структура навигации (Sidebar)

| Раздел | Подразделы | Описание |
|--------|-----------|----------|
| Dashboard | — | Сводная панель с ключевыми метриками и быстрыми действиями |
| Chats | All Chats / My Chats | Список всех чатов организации и личных чатов пользователя |
| Messenger | — | Окно переписки: чтение и отправка сообщений |
| Broadcast | Templates / Analytics | Массовые рассылки: создание, управление, шаблоны, аналитика |
| Activity | — | Лог действий пользователей и системных событий |
| Settings | Profile / Workspace / Integrations / Broadcast Settings / General | Настройки профиля, организации и подключений |

**Связи между разделами:**
- Chats (клик по чату) → Messenger с открытым чатом
- Broadcast (создание рассылки) → выбор чатов из Chats + шаблон из Templates
- Dashboard (клик по виджету) → соответствующий раздел
- Activity (клик по событию) → связанный чат в Messenger

---

## Типы пользователей и права доступа

### Superadmin (владелец платформы)
- Создаёт новые организации (окружения для клиентов-компаний)
- Приглашает Администратора в каждую организацию
- Может создавать других Суперадминов
- Имеет доступ ко всем организациям и их данным
- Управляет глобальными настройками платформы (лимиты, биллинг)

### Admin (администратор организации)
- Приглашает и управляет пользователями в рамках своей организации
- Может создавать других Админов внутри своей организации
- Настраивает интеграции с мессенджерами
- Настраивает параметры антибана для рассылок (per-messenger)
- Видит все чаты своей организации
- Управляет видимостью чатов для юзеров (чекбокс)

### User (пользователь)
- Видит только чаты, которые он сам импортировал — ИЛИ все чаты организации (зависит от чекбокса Админа)
- Может отправлять рассылки в рамках лимитов Админа
- Не может создавать шаблоны и управлять настройками
- Может импортировать чаты из своих подключённых мессенджеров

### Матрица прав

| Функция | Superadmin | Admin | User |
|---------|-----------|-------|------|
| Создание организаций | Да | Нет | Нет |
| Управление пользователями | Все организации | Своя организация | Нет |
| Chats: All Chats | Все организации | Все чаты своей организации | Свои ИЛИ все (чекбокс) |
| Chats: My Chats | Свои чаты | Свои чаты | Свои чаты |
| Chats: + Add Chat | Да | Да | Да |
| Broadcast: создание | Полный доступ | Полный доступ | Только отправка |
| Broadcast: антибан | Полный доступ | Per-messenger настройка | Только просмотр |
| Broadcast: Analytics | Полный доступ | Полный доступ | Только свои |
| Templates | Полный доступ | Полный доступ | Только использование |
| Settings: Integrations | Полный доступ | Полный доступ | Только просмотр |
| Settings: Workspace | Полный доступ | Редактирование | Только просмотр |
| Settings: Visibility | Полный доступ | Управление | Нет |
| Activity | Все организации | Своя организация | Только свои |

### Настройка видимости чатов
Расположение: Settings → Workspace → Chat Visibility
- Checkbox: "Users can see all organization chats"
- Включён — все юзеры видят все импортированные чаты
- Выключен — юзер видит только чаты, которые он импортировал или которые ему назначены как Owner

### Флоу онбординга новой компании
1. Компания покупает продукт
2. Суперадмин создаёт новую организацию (Settings → Organizations → + New Organization)
3. Суперадмин указывает: название организации, email Администратора
4. Администратор получает invite → регистрируется → попадает в свою организацию
5. Администратор настраивает: интеграции, антибан, теги, видимость чатов
6. Администратор приглашает пользователей (Settings → Workspace → + Invite User)
7. Пользователи получают invite → регистрируются → подключают мессенджеры → импортируют чаты

---

## DASHBOARD

Главная страница после входа. Обзор метрик и быстрый доступ к действиям.

### Виджеты
- **Total Chats** → Chats → All Chats
- **Active Chats** (24h) → Chats с фильтром Active
- **Unread Messages** → Chats, сортировка по unread
- **Chats by Messenger** (диаграмма) → Chats с фильтром по мессенджеру
- **Recent Broadcasts** (5 последних) → Broadcast
- **Activity Feed** (10 последних) → Activity
- **My Chats Summary** → Chats → My Chats

### Кнопки быстрых действий
- **+ New Broadcast** → Broadcast
- **+ Add Chat** → Chats (модал импорта)
- **Go to Chats** → Chats → All Chats

---

## CHATS

Таблица всех импортированных чатов организации.

### Механизм импорта чатов (+ Add Chat)
1. Выбор мессенджера (только Connected)
2. Загрузка списка чатов из мессенджера (название, тип, участники, дата)
3. Мультивыбор чекбоксами (Already added — серые)
4. Подтверждение: "Add X chats"

**Логика:**
- Импортированные чаты сохраняются на уровне организации и не исчезают при отключении
- При отключении мессенджера → Read-only (нельзя отправлять, можно читать)
- При переподключении → Active
- Imported by фиксирует, кто добавил чат

### Табы
- **All Chats** — все чаты организации (Admin видит все; User — зависит от чекбокса)
- **My Chats** — Owner = текущий пользователь OR Imported by = текущий

### Колонки таблицы
Checkbox | Chat Name | Messenger (badge) | Status (Active/Read-only) | Last Activity | Tags (multi-select) | Amount of Messages | Owner | Imported by

### Действия над таблицей
- **+ Add Chat** (primary) — модал импорта
- **Search** — поиск по названию
- **Filter** — по мессенджеру, тегам, owner, статусу, дате
- **Sorting** — Last Activity (default), Name A-Z, Messages, Owner
- **Bulk Assign** — массовая смена Owner (при выделении 1+ строк)
- **Bulk Tag** — массовое добавление/удаление тегов
- **Remove** (danger) — удаление чатов из системы (не из мессенджера)

---

## MESSENGER

Экран переписки. 3-колоночный layout.

### Левая панель — Chat List (300px)

**Элементы:**
- Search (по названию и содержимому)
- Filter bar: по мессенджеру (toggle иконки), по тегам (dropdown), по статусу (All/Unread/Active/Read-only)
- Group by: None / By Messenger / By Tag / By Owner
- Sort: Last activity / Unread first / Name A-Z / Name Z-A
- Chat list: аватар, название, иконка мессенджера, превью, время, badge непрочитанных
- Pinned секция сверху
- Favorites — звёздочка рядом с названием

**Контекстное меню чата (right-click / "..."):**
- Pin chat / Unpin
- Add to favorites / Remove
- Mark as read / Mark as unread
- Mute chat (отключает уведомления)
- Change owner (dropdown)
- Open in Chats

**Active state:** background: accent-bg, border-left: 3px solid accent

### Центральная панель — Chat Window

- Chat header: название, иконка мессенджера, кнопка Chat Info
- Message feed: хронологический поток, аватары, имена, текст, время, статус доставки
- Date dividers: Today, Yesterday, дата
- Reply preview: над полем ввода при Reply
- Message input: текст + прикрепить файл + emoji + отправить

**Контекстное меню сообщения:**
- **Reply** — нативный reply (Telegram, Slack, WhatsApp; Gmail — цитирование)
- **Forward** — модал выбора чата
- **Copy text**
- **Edit** (только свои) — текст в поле ввода, Send → "Save edit", пометка "(edited)". Telegram: 48ч, Slack: без лимита, WhatsApp: 15 мин, Gmail: не поддерживается
- **Pin** — Chat Info → Pinned messages
- **Delete** (только свои) — Telegram/Slack/WhatsApp: да, Gmail: нет

### Правая панель — Chat Info (toggle)
Chat name, Messenger, Status, Owner, Imported by, Tags, Created, Total messages, Participants (+ Add participant), Pinned messages

### Добавление участников (+ Add participant)
- Telegram: группы и супергруппы (username/user_id). Нужны права админа
- Slack: каналы и group DM (email/user_id). Для приватных — нужны права
- WhatsApp: группы (номер телефона). Только админы, макс 1024
- Gmail: не поддерживается. Заменяется на "+ Add CC/BCC"
- Для 1:1 чатов — кнопка скрыта (кроме Slack → создаёт group DM)

---

## BROADCAST

### Broadcast List
Колонки: Name | Status (Draft/Scheduled/Sending/Sent/Partially Failed/Failed) | Chats | Messengers | Created by | Sent at | Delivery rate | Failed chats

### New Broadcast (wizard, 4 шага)
1. **Content:** Broadcast Name, Message Text (Markdown), Use Template, Attachments
2. **Recipients:** Select Chats (фильтры по мессенджеру/тегам/owner), Selected count
3. **Schedule:** Send now / Schedule (date-time picker)
4. **Review:** Сводка + Risk indicator + Estimated time + Send/Schedule

### Broadcast Detail
Сводка, Delivery stats, Failed chats list (название, мессенджер, причина, статус retry), Retry controls

### Auto-retry
- Toggle вкл/выкл (Settings → Broadcast Settings)
- Max retry attempts: 1-5 (default 3)
- Exponential backoff: 1x → 2x → 4x
- Retry window: 1-24 часа

### Логика
- Отправка последовательно с задержками (per-messenger антибан)
- От имени пользователя, создавшего рассылку
- Activity логирование
- Sending → Sent / Partially Failed

---

## BROADCAST ANALYTICS

Расположение: Broadcast → Analytics

### Метрики
- Total broadcasts, Messages sent, Delivery rate, Response rate, Avg time to first reply, Open rate (Gmail only)

### По мессенджерам
Messenger | Sent | Delivered | Delivery % | Failed | Responses | Response % | Avg reply time

### Фильтры
Period (week/month/quarter/custom) | Messenger | Created by

---

## АНТИБАН-НАСТРОЙКИ (Settings → Broadcast Settings)

### Per-messenger настройки (отдельные ползунки для каждого)

**Telegram:** Messages per batch (1-50), Delay between messages (1-60s), Delay between batches (30s-30min), Max/hour (10-200), Max/day (50-2000)

**WhatsApp:** Messages per batch (1-20), Delay between messages (5-120s), Delay between batches (2-60min), Max/hour (5-50), Max/day (20-500)

**Slack:** Messages per batch (1-100), Delay between messages (0.5-30s), Delay between batches (10s-10min), Max/hour (50-500), Max/day (200-5000)

**Gmail:** Messages per batch (1-30), Delay between messages (3-60s), Delay between batches (1-30min), Max/hour (10-100), Max/day (50-2000)

### Risk Meter (под каждым мессенджером)
- Горизонтальная полоса-градиент (зелёный → жёлтый → оранжевый → красный)
- Маркер текущего уровня
- Зоны: Safe / Moderate / Risky / Dangerous
- Дополнительно: Estimated sending time, Daily capacity, Per-messenger warnings

### Права доступа
- Superadmin: глобальные максимумы
- Admin: настройка в рамках максимумов
- User: только просмотр

---

## TEMPLATES

### Список шаблонов
Template Name | Content preview | Created by | Last modified | Usage count

### Редактор
Template Name, Message Text (Markdown + предпросмотр), Variables ({{chat_name}}, {{owner_name}}, {{date}}), Save/Cancel

---

## ACTIVITY

### Activity Feed
Timestamp | User | Action | Target (кликабельный)

### Типы событий
- Chats: imported, assigned, tag changed, removed
- Messages: sent, received, failed, reply sent
- Broadcast: created, sent, scheduled, partially failed, retry succeeded
- Templates: created, edited, deleted
- Users: created, role changed, deactivated
- Integrations: connected, disconnected, token expired
- Settings: workspace changed, tag created/deleted, anti-ban changed, chat visibility changed
- Organizations: created, admin invited, settings changed

### Фильтры
By User | By Action type | By Date range

---

## SETTINGS

### Organizations (Superadmin only)
Таблица организаций: название, пользователи, дата, статус (Active/Suspended)
+ New Organization, Edit, Suspend/Activate, Global broadcast limits

### Profile
Name, Email (read-only), Avatar, Password (Change Password), Save

### Workspace (Admin+)
Organization Name, Logo, Default Language, Timezone, Chat Visibility checkbox, Save

**User Management:** Name, Email, Role, Status, Last active, Imported chats
Кнопки: + Invite User, Deactivate, Edit Role

### Integrations
Карточки: Telegram (OAuth/API token), Slack (OAuth), WhatsApp (Business API/QR), Gmail (OAuth)
Кнопки: Connect, Disconnect, Reconnect, Settings

### Broadcast Settings
Per-messenger антибан (см. раздел АНТИБАН)

### General Settings
Chat Tags (list, + New Tag, Edit, Delete)
Notifications (Email toggle, Desktop toggle, Notification scope)

---

## ДИЗАЙН-СИСТЕМА

### Типографика
- Основной: Inter
- Моноширинный: JetBrains Mono
- Заголовки: weight 600-700, letter-spacing -0.3px
- Тело: weight 400, line-height 1.5
- Labels: weight 500, 11-12px, uppercase

### Цвета
- Accent: #6366f1 (Indigo-500), hover: #4f46e5, bg: #eef2ff
- Text: #1e293b (primary), #64748b (secondary), #94a3b8 (muted)
- Background: #ffffff (primary), #f8fafc (secondary), #f1f5f9 (tertiary)
- Border: #e2e8f0, #cbd5e1 (emphasis)
- Semantic: Success #16a34a, Warning #d97706, Danger #dc2626
- Messengers: TG #0c447c/#e6f1fb, SL #3c3489/#eeedfe, WA #3b6d11/#eaf3de, GM #a32d2d/#fcebeb

### Sidebar
- Gradient: #1e1b4b → #312e81
- Glass hover: rgba(255,255,255,0.08) + backdrop-filter: blur(8px)

### Компоненты
- Cards: shadow-xs, hover shadow-sm, no borders, radius 12px
- Buttons: radius 8px, translateY(-1px) hover, scale(0.98) active
- Inputs: 1.5px border, focus ring 3px rgba(99,102,241,0.15)
- Pills/Tags: rounded-full 20px
- Modals: backdrop-filter blur(4px), radius 16px, shadow-md
- Chat avatars: 14px radius (rounded square)
- Message bubbles: 18px radius, incoming bg2, outgoing accent
- Chat list: 300px, active border-left 3px accent
- Transitions: cubic-bezier(.4,0,.2,1) 0.2s

---

## Карта переходов

| Откуда | Действие | Куда |
|--------|---------|------|
| Dashboard → Chats widget | Клик | Chats → All Chats |
| Dashboard → My Chats | Клик | Chats → My Chats |
| Dashboard → Broadcasts | Клик | Broadcast |
| Dashboard → Activity Feed | Клик | Activity |
| Dashboard → + New Broadcast | Клик | Broadcast → New |
| Dashboard → + Add Chat | Клик | Chats → Add modal |
| Chats → Chat row | Клик | Messenger (открытый чат) |
| Messenger → Pin chat | Right-click | Секция Pinned |
| Messenger → Add to favorites | Right-click | Звёздочка |
| Messenger → Filter by tag | Клик | Фильтр списка |
| Messenger → Group by | Клик | Группировка списка |
| Messenger → + Add participant | Клик | Модал добавления |
| Messenger → Edit message | Клик (свои) | Поле ввода → Save edit |
| Messenger → Reply | Клик | Reply mode с превью |
| Messenger → Forward | Клик | Модал выбора чата |
| Broadcast → New → Use Template | Клик | Список Templates |
| Broadcast → New → Select Chats | Клик | Список Chats |
| Broadcast → New → Review | Просмотр | Risk indicator |
| Broadcast → Failed chats | Клик | Список failed |
| Broadcast → Analytics | Клик | Аналитика |
| Activity → Target | Клик | Messenger / Broadcast / Settings |
| Settings → Organizations | Клик | Таблица организаций |
| Settings → Integrations → Connect | Клик | OAuth flow |
| Settings → Workspace → Invite | Клик | Invite form |
| Settings → Chat Visibility | Toggle | Переключает видимость |
| Settings → Broadcast Settings | Клик | Per-messenger антибан |
