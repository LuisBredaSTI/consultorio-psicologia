# Consultório de Psicologia — V28.10.1

- Histórico do paciente no formato da planilha: Data | Valor | Observação (a observação é o status: Faltou, Sem antecedência, Desmarcou, Desmarquei...), pagamentos ao lado, linhas verdes conforme os pagamentos cobrem as sessões, fonte maior e tudo editável no grid.
- Pacientes: lista mais larga com nomes inteiros (quebram em duas linhas); abre em 90%.
- Controle de tamanho da tela (− 85% +) no rodapé do menu, lembrado separadamente para cada tela; a Agenda começa em 85%.
- Removida a importação de planilha (já concluída).
- Novo visual (etapa 3): Financeiro em painel: 4 números principais (A receber, Atrasados, Recebido, Atendido), gráfico Atendido × Recebido, lista "Quem está devendo" com botões Pagamento e WhatsApp, e abas de detalhe (A receber, Atrasados, Recebimentos, Atendimento, Faltas, Reagendadas).
- Novo visual (etapa 2): Agenda com grade que preenche a tela, cartões limpos (a cor da faixa é o status), painel "Hoje" com botões Realizada/Faltou/Desmarcou, detalhes da sessão ao clicar e revisão das sessões de dias anteriores sem status.
- Novo visual (etapa 1): menu lateral com ícones (compacto em telas menores) e tela de Pacientes em lista + ficha, com cadastro, sessões e pagamentos editáveis na mesma tela; pensado para notebook de 15" (1366×768).
- Histórico do paciente: sessões cobradas do mês corrente ainda não cobertas pelos pagamentos ficam em amarelo (cobertas ficam verdes).
- Histórico do paciente não lista sessões apenas agendadas.
- Histórico do paciente: botão "Registrar pagamento" (data e valor) no canto superior direito.
- Agenda: sessão realizada fica verde.
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
