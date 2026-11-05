# Consultório de Psicologia — V28.5.2

- Histórico do paciente no formato da planilha: Data | Valor | Observação (a observação é o status: Faltou, Sem antecedência, Desmarcou, Desmarquei...), pagamentos ao lado, linhas verdes conforme os pagamentos cobrem as sessões, fonte maior e tudo editável no grid.
- Histórico do paciente não lista sessões apenas agendadas.
- Histórico do paciente: botão "Registrar pagamento" (data e valor) no canto superior direito.
- Agenda: sessão realizada fica verde.
- Financeiro > Importar planilha: lê a planilha de controle (.xlsx), mostra a prévia por paciente (sessões cobradas, pagamentos, saldos) e aplica após confirmação, com cópia de segurança do banco e conferência de saldos.
- Atalho aponta para Consultorio.exe (em vez do PowerShell) e há uma cópia no Menu Iniciar: evita que o antivírus remova o atalho.
- Novo status "Desmarquei" (a profissional desmarcou): libera o horário e não gera financeiro.
- "Desmarcou" e "Desmarquei" são reversíveis: clique na linha cinza da agenda para voltar para Agendada ou reagendar.
- Compromissos pessoais em horários quebrados (ex.: 08:40) aparecem no slot da hora; conflitos são verificados por hora.
- Agendar sessão tem a opção de repetir nas próximas semanas (no mesmo dia e horário).
- Botão "Excluir agendamentos" no cadastro de pacientes: remove os agendamentos futuros e oferece gerar de novo conforme o cadastro.
- "Preencher agenda" não recria sessões desmarcadas, reagendadas ou excluídas.
- Quinzenal a cada 14 dias (mesmo dia da semana); pacientes editados direto no grid.
- Instalação nova: o programa cria as tabelas básicas quando não há banco de dados.
- Revisão geral do código: remoção de código morto e duplicado.

Este pacote não contém dados de pacientes.
