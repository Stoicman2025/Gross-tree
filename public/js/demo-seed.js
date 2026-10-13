// Вымышленная семья для демо-режима.

export function demoSeed() {
  const t = new Date('2026-01-01T00:00:00Z').getTime();
  let n = 0;
  const ts = () => new Date(t + (n++) * 60000).toISOString();
  const P = (id, f) => ({
    id, first_name: '', patronymic: '', last_name: '', maiden_name: '', gender: '',
    birth_date: '', birth_approx: false, birth_place: '', is_deceased: false, death_date: '',
    death_approx: false, death_place: '', occupation: '', bio: '', main_photo_id: null,
    created_at: ts(), updated_at: ts(), ...f,
  });

  const people = [
    P('d-nik', { first_name: 'Николай', patronymic: 'Иванович', last_name: 'Соколов', gender: 'm', birth_date: '1921-05-09', birth_place: 'Тверская губерния', is_deceased: true, death_date: '1995', occupation: 'Инженер-путеец', bio: 'Прошёл всю войну связистом, дошёл до Праги. После войны строил железные дороги на Урале.' }),
    P('d-anna', { first_name: 'Анна', patronymic: 'Петровна', last_name: 'Соколова', maiden_name: 'Белова', gender: 'f', birth_date: '1924', birth_approx: true, birth_place: 'Калинин', is_deceased: true, death_date: '2010-11-02', occupation: 'Учитель литературы' }),
    P('d-mih', { first_name: 'Михаил', patronymic: 'Сергеевич', last_name: 'Орлов', gender: 'm', birth_date: '1925', is_deceased: true, death_date: '2001', occupation: 'Агроном' }),
    P('d-vera', { first_name: 'Вера', patronymic: 'Алексеевна', last_name: 'Орлова', gender: 'f', birth_date: '1928-03-14', is_deceased: true, death_date: '2015' }),
    P('d-serg', { first_name: 'Сергей', patronymic: 'Николаевич', last_name: 'Соколов', gender: 'm', birth_date: '1948-08-21', birth_place: 'Свердловск', occupation: 'Врач-хирург' }),
    P('d-elena', { first_name: 'Елена', patronymic: 'Михайловна', last_name: 'Соколова', maiden_name: 'Орлова', gender: 'f', birth_date: '1951-02-02', birth_place: 'Рязань' }),
    P('d-olga', { first_name: 'Ольга', patronymic: 'Николаевна', last_name: 'Кравец', maiden_name: 'Соколова', gender: 'f', birth_date: '1952-12-30' }),
    P('d-vik', { first_name: 'Виктор', patronymic: 'Павлович', last_name: 'Кравец', gender: 'm', birth_date: '1950', is_deceased: true, death_date: '2018' }),
    P('d-andr', { first_name: 'Андрей', patronymic: 'Михайлович', last_name: 'Орлов', gender: 'm', birth_date: '1955-07-07' }),
    P('d-dima', { first_name: 'Дмитрий', patronymic: 'Сергеевич', last_name: 'Соколов', gender: 'm', birth_date: '1975-04-18', birth_place: 'Екатеринбург', occupation: 'Программист' }),
    P('d-mar', { first_name: 'Марина', patronymic: 'Олеговна', last_name: 'Соколова', maiden_name: 'Зайцева', gender: 'f', birth_date: '1978' }),
    P('d-ira', { first_name: 'Ирина', patronymic: 'Сергеевна', last_name: 'Соколова', gender: 'f', birth_date: '1980-10-10' }),
    P('d-pav', { first_name: 'Павел', patronymic: 'Викторович', last_name: 'Кравец', gender: 'm', birth_date: '1977-01-25' }),
    P('d-art', { first_name: 'Артём', patronymic: 'Дмитриевич', last_name: 'Соколов', gender: 'm', birth_date: '2005-06-01' }),
    P('d-sof', { first_name: 'Софья', patronymic: 'Дмитриевна', last_name: 'Соколова', gender: 'f', birth_date: '2009-09-09' }),
  ];

  const pc = (parent_id, child_id) => ({ parent_id, child_id, kind: 'birth', created_at: ts() });
  const parent_child = [
    pc('d-nik', 'd-serg'), pc('d-anna', 'd-serg'),
    pc('d-nik', 'd-olga'), pc('d-anna', 'd-olga'),
    pc('d-mih', 'd-elena'), pc('d-vera', 'd-elena'),
    pc('d-mih', 'd-andr'), pc('d-vera', 'd-andr'),
    pc('d-serg', 'd-dima'), pc('d-elena', 'd-dima'),
    pc('d-serg', 'd-ira'), pc('d-elena', 'd-ira'),
    pc('d-olga', 'd-pav'), pc('d-vik', 'd-pav'),
    pc('d-dima', 'd-art'), pc('d-mar', 'd-art'),
    pc('d-dima', 'd-sof'), pc('d-mar', 'd-sof'),
  ];

  const un = (id, a, b, status = 'married', start_date = '') => ({ id, partner1_id: a, partner2_id: b, status, start_date, end_date: '', created_at: ts() });
  const unions = [
    un('u1', 'd-nik', 'd-anna', 'married', '1946'),
    un('u2', 'd-mih', 'd-vera', 'married', '1949'),
    un('u3', 'd-serg', 'd-elena', 'married', '1973'),
    un('u4', 'd-olga', 'd-vik', 'married', '1975'),
    un('u5', 'd-dima', 'd-mar', 'married', '2003'),
  ];

  const submissions = [{
    id: 'demo-sub-1',
    kind: 'new_person',
    target_person_id: null,
    payload: {
      person: { first_name: 'Алиса', patronymic: 'Павловна', last_name: 'Кравец', gender: 'f', birth_date: '2012-03-08' },
      relations: { add: [{ type: 'parent', ref: { id: 'd-pav' } }, { type: 'parent', ref: { new: { first_name: 'Татьяна', last_name: 'Кравец', patronymic: '', gender: 'f', birth_date: '' } } }], remove: [] },
      photos: [],
    },
    author_name: 'Павел Кравец',
    comment: 'Добавляю дочку и жену. Таня пока сама не заполняла анкету.',
    status: 'pending',
    admin_note: '',
    created_at: ts(),
    reviewed_at: null,
  }];

  return { title: 'Семья Соколовых', familyCode: 'демо', people, parent_child, unions, photos: [], submissions };
}
