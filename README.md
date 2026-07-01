# GO REGISTER Site

Versao web do GO REGISTER, conectada ao mesmo projeto Firebase usado no aplicativo Android.

Apesar de nao exigir build, a aplicacao e dinamica: as telas leem e gravam no Firestore, escutam mudancas em tempo real e usam rotas internas por hash.

## Como rodar

Na pasta do repositorio:

```powershell
cd site
python -m http.server 5173
```

Depois acesse:

```text
http://localhost:5173
```

## Primeiro acesso

No primeiro acesso, quando a colecao `users` ainda estiver vazia, informe o usuario e a senha desejados na tela de login.
O site cria esse primeiro usuario como `Administrador Mestre`.

Depois disso, novos usuarios devem ser criados em **Ajustes > Gerenciar Usuarios** por um administrador.

## Colecoes Firestore usadas

- `products`
- `sales`
- `categories`
- `suppliers`
- `cash_registers`
- `financial_entries`
- `financial_exits`
- `users`
- `stock_movements`

## Funcionalidades no site

- Operador: painel, vendas/PDV, abrir e fechar caixa, entradas e saidas manuais, ajustes basicos e logout
- Administrador: tudo do operador mais estoque, categorias, fornecedores, usuarios, relatorios e historicos
- Realizar vendas no PDV
- Aplicar desconto na venda
- Controlar quantidade no carrinho
- Baixar estoque automaticamente ao vender
- Cancelar venda, entrada ou saida com credenciais de um administrador ativo
- Devolver estoque automaticamente ao cancelar venda
- Cadastrar, editar e excluir produtos, categorias e fornecedores
- Gerenciar usuarios
- Ajustar estoque manualmente
- Ver historico de estoque
- Ver historico de caixa com saldo esperado, informado e diferenca
