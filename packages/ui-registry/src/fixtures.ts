import type { UISpec } from '@agentic-os/contracts';

/**
 * Фикстура «все компоненты сразу».
 *
 * Нужна для двух вещей: убедиться, что каждый тип из реестра действительно
 * рендерится (объявленный, но не реализованный компонент валидатор пропустит,
 * а пользователь увидит заглушку), и снять с этого скриншот в обеих темах.
 *
 * Держится рядом с реестром намеренно: добавил компонент — добавь сюда,
 * иначе он выйдет в продакшен ни разу не отрисованным.
 */
export const KITCHEN_SINK: UISpec = {
  schemaVersion: '1.0',
  id: 'dev-registry',
  version: 1,
  title: 'Реестр компонентов',
  dataSources: [],
  meta: { origin: 'catalog', graphRefs: [], runtimeKeys: [], shareable: false },
  root: {
    type: 'screen',
    props: { title: 'Реестр' },
    children: [
      {
        type: 'section',
        children: [
          { type: 'heading', props: { text: 'Реестр компонентов', level: 1 } },
          { type: 'text', props: { text: 'Все типы, которые умеет рендерить клиент', tone: 'muted' } },
          { type: 'row', props: { wrap: true }, children: [
            { type: 'badge', props: { text: 'default' } },
            { type: 'badge', props: { text: 'success', tone: 'success' } },
            { type: 'badge', props: { text: 'warning', tone: 'warning' } },
            { type: 'badge', props: { text: 'danger', tone: 'danger' } },
          ] },
        ],
      },

      { type: 'card', children: [
        { type: 'heading', props: { text: 'Текст и медиа', level: 2 } },
        { type: 'label', props: { text: 'Подпись' } },
        { type: 'markdown', props: { text: 'Абзац с **выделением**.\n\n- первый пункт\n- второй пункт' } },
        { type: 'row', children: [
          { type: 'avatar', props: { name: 'Олег Баранов' } },
          { type: 'icon', props: { name: 'flag', size: 24 } },
          { type: 'link', props: { label: 'Ссылка на источник' } },
        ] },
        { type: 'divider' },
        { type: 'image', props: { uri: 'https://example.org/none.png', height: 80 } },
        { type: 'stack', props: { gap: 1 }, children: [
          { type: 'text', props: { text: 'Вертикальная стопка', tone: 'muted' } },
        ] },
        { type: 'scroll', props: { horizontal: true }, children: [
          { type: 'badge', props: { text: 'прокрутка' } },
          { type: 'badge', props: { text: 'по горизонтали' } },
        ] },
        { type: 'keyValue', props: { items: [
          { key: 'Срок', value: 'до 1 октября' },
          { key: 'Стоимость', value: '8 500 ₽' },
        ] } },
      ] },

      { type: 'card', children: [
        { type: 'heading', props: { text: 'Данные', level: 2 } },
        { type: 'row', props: { gap: 4 }, children: [
          { type: 'stat', props: { label: 'Закрыто', value: '12', hint: 'за неделю' } },
          { type: 'stat', props: { label: 'В работе', value: '3', tone: 'warning' } },
        ] },
        { type: 'progress', props: { label: 'Готовность', value: 0.62 } },
        { type: 'chart', props: { series: [
          { label: 'Пн', value: 3 }, { label: 'Вт', value: 5 },
          { label: 'Ср', value: 2 }, { label: 'Чт', value: 6 },
        ] } },
        { type: 'table', props: {
          headers: ['Этап', 'Срок'],
          rows: [['Документы', '12.09'], ['Подача', '20.09']],
        } },
        { type: 'timeline', props: { items: [
          { title: 'Собрал документы', at: 'вчера', done: true },
          { title: 'Подать заявление', at: '20 сентября' },
        ] } },
        { type: 'calendar', props: { events: [
          { title: 'Визовый центр', startsAt: '2026-09-20T10:30:00Z', location: 'Пресненская наб., 10' },
        ] } },
        { type: 'stepper', props: { steps: [
          { title: 'Собрать экран', status: 'done' },
          { title: 'Найти требования', status: 'running' },
          { title: 'Поставить напоминание', status: 'pending' },
        ] } },
      ] },

      { type: 'card', children: [
        { type: 'heading', props: { text: 'Списки', level: 2 } },
        { type: 'list', children: [
          { type: 'listItem', props: { title: 'Обычный пункт', subtitle: 'с подписью', trailing: '2 дня' } },
        ] },
        { type: 'checklist', children: [
          { type: 'listItem', props: { title: 'Отмеченный пункт', checked: true } },
          { type: 'listItem', props: { title: 'Неотмеченный пункт', checked: false } },
        ] },
        { type: 'comparisonTable', props: {
          criteria: ['Цена', 'Срок'],
          items: [
            { title: 'Вариант А', subtitle: 'дешевле', values: ['8 500 ₽', '10 дней'], recommended: true },
            { title: 'Вариант Б', values: ['12 000 ₽', '3 дня'] },
          ],
        } },
      ] },

      { type: 'card', children: [
        { type: 'heading', props: { text: 'Ввод', level: 2 } },
        { type: 'form', children: [
          { type: 'textField', props: { label: 'Имя', placeholder: 'Как к тебе обращаться' } },
          { type: 'textArea', props: { label: 'Комментарий', placeholder: 'Пара слов' } },
          { type: 'numberField', props: { label: 'Бюджет', placeholder: '50000' } },
          { type: 'select', props: { label: 'Город', value: 'msk', options: [
            { value: 'msk', label: 'Москва' }, { value: 'spb', label: 'Петербург' },
          ] } },
          { type: 'multiSelect', props: { label: 'Что важно', value: ['price'], options: [
            { value: 'price', label: 'Цена' }, { value: 'speed', label: 'Скорость' }, { value: 'trust', label: 'Надёжность' },
          ] } },
          { type: 'radioGroup', props: { label: 'Кто едет', value: 'one', options: [
            { value: 'one', label: 'Один' }, { value: 'family', label: 'С семьёй' },
          ] } },
          { type: 'checkbox', props: { label: 'Нужна страховка', value: true } },
          { type: 'toggle', props: { label: 'Напоминать заранее', value: true } },
          { type: 'slider', props: { label: 'Сколько человек', value: 3, min: 1, max: 8, unit: 'чел.' } },
          { type: 'rating', props: { label: 'Оценка', value: 4 } },
          { type: 'datePicker', props: { label: 'Когда', value: '' } },
          { type: 'timePicker', props: { label: 'Во сколько', value: '12:00' } },
        ] },
      ] },

      { type: 'card', children: [
        { type: 'heading', props: { text: 'Действия и состояния', level: 2 } },
        { type: 'buttonGroup', children: [
          { type: 'button', props: { label: 'Основное' } },
          { type: 'button', props: { label: 'Второе', variant: 'secondary' } },
        ] },
        { type: 'alert', props: { tone: 'warning', title: 'Правило', text: 'Аванс не больше 30 процентов.' } },
        { type: 'skeleton', props: { lines: 3 } },
        { type: 'confirmSheet', props: { text: 'Отправить сообщение мастеру?' } },
        { type: 'confirmSheet', props: {
          tone: 'danger',
          text: 'Удалить всё безвозвратно? Граф, задачи и журнал восстановить будет нельзя.',
          confirmLabel: 'Удалить всё',
          cancelLabel: 'Оставить',
        } },
        { type: 'emptyState', props: { icon: 'doc', title: 'Пока пусто', text: 'Здесь появятся результаты' } },
        { type: 'spacer', props: { size: 2 } },
        // Зазор 4 намеренно: именно на нём сетка раньше схлопывалась в колонку.
        { type: 'grid', props: { columns: 2, gap: 4 }, children: [
          { type: 'stat', props: { label: 'Слева', value: '1' } },
          { type: 'stat', props: { label: 'Справа', value: '2' } },
        ] },
      ] },

      /*
       * Агентность. Единственная часть реестра, ради которой продукт
       * существует: всё остальное умеет любой список дел.
       */
      { type: 'card', children: [
        { type: 'heading', props: { text: 'Чей ход', level: 2 } },
        { type: 'agentDid', props: {
          title: 'Записал тебя на подачу документов',
          at: 'вчера 14:20',
          undoUntil: 'ещё 4 ч 12 мин',
        }, actions: { onUndo: { kind: 'tool', tool: 'task.toggle_item', args: {} } } },
        { type: 'agentIntent', props: {
          title: 'Отправить анкету в визовый центр',
          before: 'анкета не подана',
          after: 'подана 24 июля',
          discloses: 'анкета и скан паспорта',
          confirmLabel: 'Подтверждаю',
        }, actions: { onConfirm: { kind: 'tool', tool: 'task.toggle_item', args: {} } } },
        { type: 'awaiting', props: {
          who: 'визовый центр',
          since: '3 августа',
          usually: '5 дней',
        }, actions: { onNudge: { kind: 'tool', tool: 'task.toggle_item', args: {} } } },
        { type: 'sourceStamp', props: { source: 'с твоих слов', confidence: 0.9 } },
        { type: 'sourceStamp', props: { source: 'предположение', confidence: 0.3 } },
      ] },
    ],
  },
};
