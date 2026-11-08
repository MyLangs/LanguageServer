/**
 * Hover documentation for the MyLang VS Code extension.
 * All examples follow the MyLang2 README.
 *
 * Entry shape:
 *   category     short label shown next to the title
 *   syntax       one-line (or short) signature
 *   description  markdown explanation
 *   example      code block
 *   output       what the example prints (optional)
 *   tip          "good to know" note (optional)
 *   warning      pitfall (optional)
 *   related      other keywords worth looking at (optional)
 *   when         (ctx) => boolean, ctx = { before, after } text of the line
 *                around the word. Used where a plain word is ambiguous.
 */

// Trims the leading/trailing newline of a template literal.
const ex = (s) => s.replace(/^\n/, "").replace(/\n\s*$/, "");

// ───────────────────────────── Keywords ─────────────────────────────

const KEYWORD_DOCS = {
  // ── declarations ──
  var: {
    category: "declaration",
    syntax: "var name = value;",
    description:
      "Declares a variable. Without an initializer it starts as `nil`. The same keyword also covers **multi-declarations** and **destructuring** of arrays, objects and multiple return values, and accepts modifiers through `as` (`const`, `readonly`, `lazy`).",
    example: ex(`
var username;                  // nil
var age = 25;

// several variables at once
var (
  firstName,
  lastName = "Doe",
  birthYear = 1990 as readonly
);

// destructuring
var [first, second, ...rest] = [1, 2, 3, 4];
var { value } = { value: 10 };
var (name, years, role) = getUserInfo();
`),
    tip: "A variable with no initializer is `nil`, not an error.",
    related: ["const", "readonly", "lazy"],
  },

  const: {
    category: "modifier",
    syntax: "var name = value as const;",
    description:
      "Used after `as` to lock the **variable**: it can never be reassigned. The value itself is *not* frozen, so an array or object marked `const` can still change inside. Use `readonly` when the contents must be protected too.",
    example: ex(`
var maxConnections = 100 as const;
// maxConnections = 200;   // Error: Assignment to constant variable

var cart = [] as const;
cart[0] = "laptop";         // OK: the contents may change
// cart = ["phone"];        // Error: Cannot reassign constant variable
`),
    tip: "`const` protects the label, `readonly` protects what is inside the box.",
    related: ["readonly", "as", "var"],
  },

  readonly: {
    category: "modifier",
    syntax: "var name = [ ... ] as readonly;",
    description:
      "Used after `as` to make a collection **read-only**: its elements can't be modified after creation. It is the stricter sibling of `const`, which only forbids reassigning the variable.",
    example: ex(`
var priceList = [99, 199, 299] as readonly;

coreio.print(priceList[1]);   // 199 — reading is fine
// priceList[0] = 50;         // Error: Cannot modify readonly array

// also works inside a multi-declaration
var (
  appName = "Todo",
  birthYear = 1990 as readonly
);
`),
    related: ["const", "as"],
  },

  lazy: {
    category: "modifier",
    syntax: "var name = expression as lazy;",
    description:
      "Delays evaluation until the variable is **first used**. If no code path ever touches it, the initializer never runs. Ideal for files, network calls or heavy calculations that only some branches need.",
    example: ex(`
// "photo.png" is NOT loaded here
var photo = import("photo.png") as lazy;

var choice = +coreio.input("Photo or text? 1/2");

if (choice == 1) {
  fs.writeFile("newFile", photo);   // first use: the file is loaded now
} else {
  coreio.print("Hello World");      // photo.png is never read
}
`),
    related: ["var", "import", "as"],
  },

  // ── functions ──
  func: {
    category: "function",
    syntax: "func name(a, b = 1, ...rest) { ... }",
    description:
      "Declares a function. Parameters may have **default values**, and a final **rest parameter** collects any extra arguments. Functions are values: you can store them in variables and objects, pass them around, or write them anonymously as `func(x) { ... }`.",
    example: ex(`
func createUser(name, age = 18, role = "user") {
  return { name: name, age: age, role: role };
}

func sum(...numbers) {
  var total = 0;
  for (var n in numbers) {
    total += n;
  }
  return total;
}
coreio.print(sum(1, 2, 3, 4, 5));   // 15

// functions are values
var applyTwice = func(f, x) { return f(f(x)); };
var double = func(n) { return n * 2; };
coreio.print(applyTwice(double, 5)); // 20
`),
    related: ["return", "defer", "spawn"],
  },

  return: {
    category: "function",
    syntax: "return value;   |   return (a, b, c);",
    description:
      "Leaves the current function immediately. A bare `return;` gives back `nil`, and a **tuple** `(a, b, c)` returns several values at once, which the caller can unpack with `var ( ... ) = call()`.",
    example: ex(`
func describe(user) {
  if (!user) {
    return;                          // exit early, result is nil
  }
  return (user.name, user.age);      // multiple values
}

var (name, age) = describe({ name: "Alice", age: 30 });
coreio.print(name, age);             // Alice 30
`),
    tip: "Any `defer` scheduled in the function still runs before it returns.",
    related: ["func", "defer"],
  },

  init: {
    category: "struct",
    syntax: "func init(params) { ... }",
    description:
      "The **constructor** of a struct. It runs automatically when you create an instance by calling the struct like a function. It is optional: without it you assign the fields yourself.",
    example: ex(`
struct User {
  var name;
  var age;

  func init(name, age = 18) {
    this.name = name;
    this.age = age;
  }
}

var alice = User("Alice");     // init("Alice") -> age defaults to 18
coreio.print(alice.age);       // 18
`),
    when: ({ before }) => /\bfunc\s+$/.test(before),
    related: ["struct", "this"],
  },

  // ── modules ──
  import: {
    category: "module",
    syntax: 'import "module";',
    description:
      "Brings a module into scope. Standard libraries are imported by name; your own files, parent folders and even URLs by path. Several modules can be grouped in one statement, and an alias or a set of names can be picked with `as`.",
    example: ex(`
import "coreio";                          // standard library

import (                                  // several at once
  "strings",
  "arrays"
);

import "coreio" as { print, input };      // pick only what you need
import (helpers: "./utils/helpers.ml");   // alias for a local file
import "../config.ml";                    // relative path
import "https://example.com/library.ml";  // remote module
`),
    warning:
      'Combining `as { ... }` with a grouped import, such as `import ("net/http" as { Server })`, does not work yet.',
    tip: "`import.base`, `import.main`, `import.resolve(...)` and friends give you information about the module system at runtime.",
    related: ["export", "lazy", "as"],
  },

  export: {
    category: "module",
    syntax: "export(name1, name2, ...);",
    description:
      "Chooses which functions and variables other files can see when they import this module. Anything you don't list stays **private** to the file.",
    example: ex(`
// math.ml
func add(a, b) { return a + b; }
func subtract(a, b) { return a - b; }

var PI = 3.14159;
var secret = 42;                // not exported -> stays private

export(add, subtract, PI);

// main.ml
import (math: "./math.ml");
coreio.print(math.add(2, 3));   // 5
`),
    related: ["import"],
  },

  as: {
    category: "modifier",
    syntax: "value as modifier",
    description:
      "Attaches extra meaning to whatever is on its left:\n\n" +
      "- **Modifiers:** `as const`, `as readonly`, `as lazy`\n" +
      '- **Error details:** `throw "msg" as { ... }` or `as MyError`\n' +
      '- **Import names:** `import "coreio" as { print, input }`',
    example: ex(`
var limit = 100 as const;                    // can't be reassigned
var prices = [10, 20] as readonly;           // can't be modified
var report = buildReport() as lazy;          // built on first use

import "coreio" as { print, input };         // pick names from a module

throw "Not allowed" as { name: "AuthError", code: 403 };
`),
    related: ["const", "readonly", "lazy", "throw"],
  },

  // ── conditionals ──
  if: {
    category: "control flow",
    syntax: "if (condition) { ... }",
    description:
      "Runs a block only when the condition is truthy. Combine conditions with `&&` and `||`, and chain extra branches with `else if` / `else`.",
    example: ex(`
var user = { name: "Alice", role: "admin", active: true };

if (user.active && user.role == "admin") {
  coreio.print($"Welcome back, {user.name}!");
} else if (user.active) {
  coreio.print("Limited access");
} else {
  coreio.print("Account disabled");
}
`),
    output: "Welcome back, Alice!",
    tip: 'Need a *value* instead of a statement? Use the ternary: `var grade = score >= 90 ? "A" : "B";`',
    related: ["else", "match"],
  },

  else: {
    category: "control flow",
    syntax: "if (...) { ... } else { ... }",
    description:
      "The fallback branch of an `if`. Chain several checks with `else if`; the first branch whose condition is truthy wins and the rest are skipped.",
    example: ex(`
var score = 85;

if (score >= 90) {
  coreio.print("Grade: A");
} else if (score >= 80) {
  coreio.print("Grade: B");
} else {
  coreio.print("Grade: F");
}

// for a simple value, a nested ternary is shorter
var sign = score > 0 ? "positive" : score < 0 ? "negative" : "zero";
`),
    output: "Grade: B",
    tip: "`else` also appears in the expression form of `try ... else { ... }`.",
    related: ["if", "try"],
  },

  match: {
    category: "control flow",
    syntax: "match (value) { case x: { ... } default: { ... } }",
    description:
      "Compares one value against several `case` branches and runs the first that fits; `default` handles everything else. The matched value can be any expression, an enum member, or an object (use `case (.property)` to test one of its properties).",
    example: ex(`
var role = "moderator";

match (role) {
  case "admin": {
    coreio.print("Full access");
  }
  case "moderator": {
    coreio.print("Can edit posts");
  }
  default: {
    coreio.print("Read only");
  }
}

// expressions are allowed too
var value = 42;
match (value * 2) {
  case 84: { coreio.print("Double the answer"); }
  default: { coreio.print("Something else"); }
}
`),
    output: "Can edit posts\nDouble the answer",
    related: ["case", "default", "enum", "if"],
  },

  case: {
    category: "control flow",
    syntax: "case pattern: { ... }",
    description:
      "One branch of a `match`. The pattern can be a literal, an enum member such as `Status.Active`, or `(.property)` to test a property of an object. A branch may use a block, or a single statement after the colon.",
    example: ex(`
match (currentStatus) {
  case Status.Pending:   { coreio.print("Waiting..."); }
  case Status.Active:    { coreio.print("In progress"); }
  case Status.Completed: { coreio.print("Done!"); }
}

// short form: one statement after the colon
func toHex(color) {
  match (color) {
    case Color.Red: return "#FF0000";
    case Color.Blue: return "#0000FF";
  }
}
`),
    related: ["match", "default", "enum"],
  },

  default: {
    category: "control flow",
    syntax: "default: { ... }",
    description:
      "The fallback branch of a `match`: it runs when no `case` fits. Always add one when the input comes from users or files, so unexpected values are handled on purpose.",
    example: ex(`
match (user.role) {
  case "admin": { grantFullAccess(); }
  case "user":  { grantUserAccess(); }
  default: {
    denyAccess();            // unknown role -> safe fallback
  }
}
`),
    related: ["match", "case"],
  },

  // ── loops ──
  for: {
    category: "loop",
    syntax: "for (var i = 0; i < n; i++) { ... }   |   for (var x in collection) { ... }",
    description:
      "Two loop forms. The **counting** loop is classic init / condition / step. The **for-in** loop walks a collection: arrays give their **values**, objects give their **keys**, and any object with a `[symbol.iterator]` method is iterable too.",
    example: ex(`
// counting
for (var i = 1; i <= 3; i++) {
  coreio.print(i);
}

// arrays give values
for (var fruit in ["apple", "pear"]) {
  coreio.print(fruit);
}

// objects give keys
var person = { name: "Alice", age: 30 };
for (var key in person) {
  coreio.print(key, person[key]);
}
`),
    output: "1\n2\n3\napple\npear\nname Alice\nage 30",
    related: ["in", "while", "break", "continue", "symbol"],
  },

  in: {
    category: "loop",
    syntax: "for (var item in collection) { ... }",
    description:
      "Used inside `for` to iterate a collection. With an **array** the variable receives each value, with an **object** each key (look the value up with `obj[key]`), and with a **custom iterator** each value produced by `next()`.",
    example: ex(`
var items = [10, 20, 30];
for (var item in items) {
  coreio.print(item);          // 10, 20, 30
}

var stock = { apples: 4, pears: 7 };
for (var name in stock) {
  coreio.print($"{name}: {stock[name]}");   // apples: 4, pears: 7
}
`),
    related: ["for", "symbol"],
  },

  while: {
    category: "loop",
    syntax: "while (condition) { ... }",
    description:
      "Repeats a block for as long as the condition stays truthy. The condition is checked **before** each pass, so the body may never run at all.",
    example: ex(`
var attempts = 0;

while (attempts < 3) {
  coreio.print($"Attempt {attempts + 1}");
  attempts++;
}
`),
    output: "Attempt 1\nAttempt 2\nAttempt 3",
    warning: "Make sure something inside the loop changes the condition, otherwise it never ends.",
    related: ["for", "break", "continue"],
  },

  break: {
    category: "loop",
    syntax: "break;",
    description:
      'Leaves the nearest enclosing loop immediately. Perfect for "stop as soon as you found it".',
    example: ex(`
var numbers = [4, 8, 15, 16, 23, 42];
var firstOdd = nil;

for (var n in numbers) {
  if (n % 2 == 1) {
    firstOdd = n;
    break;                  // no need to look further
  }
}

coreio.print(firstOdd);     // 15
`),
    related: ["continue", "for", "while"],
  },

  continue: {
    category: "loop",
    syntax: "continue;",
    description:
      "Skips the rest of the current pass and jumps to the next one. Handy for filtering out values you don't care about.",
    example: ex(`
var total = 0;

for (var n in [5, -2, 8, -1, 3]) {
  if (n < 0) {
    continue;               // ignore negatives
  }
  total += n;
}

coreio.print(total);        // 16
`),
    related: ["break", "for", "while"],
  },

  // ── errors ──
  try: {
    category: "error handling",
    syntax: "try { ... } catch (e) { ... } finally { ... }",
    description:
      "Runs code that might fail. If something is thrown, control jumps to `catch`; `finally` runs either way. `try` also works as an **expression** that produces a value, with `catch (error)` or `else` (the error is then available as `this.error`).",
    example: ex(`
// block form
try {
  var config = fs.readFile("config.json", "utf8");
} catch (error) {
  coreio.print("Could not read config:", error);
} finally {
  coreio.print("File operation completed");
}

// expression form with catch
var notes = try fs.readFile("notes.txt", "utf8") catch (error) {
  coreio.print("Error reading file:", error);
  return nil;
}

// expression form with else
var data = try fs.readFile("data.txt", "utf8") else {
  coreio.print("Failed:", this.error);
  return nil;
}
`),
    related: ["catch", "finally", "throw"],
  },

  catch: {
    category: "error handling",
    syntax: "catch (error) { ... }",
    description:
      "Handles an error thrown inside the preceding `try`. The error object carries the message plus anything attached with `throw ... as { ... }` (name, code, cause).",
    example: ex(`
try {
  validateAge(-5);
} catch (err) {
  coreio.print(typeof err);      // error
  coreio.print(err);
}

// nested: turn a low-level error into a clearer one
try {
  try {
    validateAge(data.age);
  } catch (validationError) {
    throw "Data processing aborted";
  }
} catch (error) {
  coreio.print("Processing error:", error);
}
`),
    related: ["try", "finally", "throw"],
  },

  finally: {
    category: "error handling",
    syntax: "finally { ... }",
    description:
      "A block that **always** runs after `try` / `catch`, whether or not an error was thrown. Use it for cleanup that must happen no matter what, such as closing a file or printing a summary.",
    example: ex(`
func readConfig(filename) {
  try {
    return fs.readFile(filename, "utf8");
  } catch (error) {
    coreio.print("Error reading file:", error);
    return nil;
  } finally {
    coreio.print("File operation completed");   // runs in both cases
  }
}
`),
    tip: "For cleanup tied to a whole function, `defer` is often neater than `finally`.",
    related: ["try", "catch", "defer"],
  },

  throw: {
    category: "error handling",
    syntax: 'throw "message" [as { ... } | as ErrorStruct(...)];',
    description:
      "Raises an error and unwinds the stack until a `catch` handles it. Attach structured details with `as { ... }`, or describe the error with a struct so every part of your code throws it the same way.",
    example: ex(`
// plain message
throw "Something went wrong";

// message + details
func validateAge(age) {
  if (age < 0) {
    throw "Age cannot be negative" as {
      name: "ValidatedError",
      code: 409,
      cause: { age },
    };
  }
  return true;
}

// message + a struct as the error type
struct ValidatedError {
  var code = 409;
  var cause = { "name": "unknown error" };
  var name = "ValidatedError";
}

throw "Name must be a string" as ValidatedError(400, { name });
`),
    related: ["try", "catch", "as", "struct"],
  },

  // ── async ──
  spawn: {
    category: "concurrency",
    syntax: "spawn { ... }",
    description:
      "Starts a block as a **concurrent task** and immediately gives you a handle to it, without blocking the current code. Collect the result later with `wait`.",
    example: ex(`
func fetchData(url) {
  return spawn {
    time.sleep(1000);              // simulate a slow request
    return $"Data from {url}";
  };
}

var promise = fetchData("https://api.example.com");
coreio.print("Request sent...");   // printed right away
var data = wait promise;           // now we block until it's ready
coreio.print(data);
`),
    output: "Request sent...\nData from https://api.example.com",
    related: ["wait", "time"],
  },

  wait: {
    category: "concurrency",
    syntax: "var result = wait task;",
    description:
      "Pauses the current code until a `spawn`ed task finishes, then returns its result. Spawn several tasks first and wait afterwards to make them run **in parallel**.",
    example: ex(`
var a = spawn { time.sleep(1000); return "Task A"; };
var b = spawn { time.sleep(1000); return "Task B"; };

// both are already running, so this takes about 1 second, not 2
var first = wait a;
var second = wait b;
coreio.print(first, second);
`),
    output: "Task A Task B",
    related: ["spawn"],
  },

  // ── cleanup ──
  defer: {
    category: "resource management",
    syntax: "defer expression;",
    description:
      "Schedules an expression to run when the **enclosing function exits**, whichever way it exits (normal end, early `return`). Put the cleanup right next to the code that needs it, so you can't forget it. As an expression, `defer` can also wrap a value that has a `[symbol.dispose]` method for automatic cleanup.",
    example: ex(`
func process() {
  var resource = openResource();
  defer closeResource(resource);   // scheduled now, runs on exit

  if (isBroken(resource)) {
    return;                        // closeResource still runs
  }
  doWork(resource);
}

// expression form: cleanup via [symbol.dispose]
func readConfig(file) {
  var fd = fs.open(file, "r");
  return {
    content: fs.read(fd, bytes.Bytes(2048), 0, 2048, 0),
    [symbol.dispose]: func() { fs.close(fd); }
  };
}
var config = defer readConfig("./package.json");
`),
    related: ["finally", "func", "symbol"],
  },

  // ── types ──
  struct: {
    category: "type",
    syntax: "struct Name { var field; func method() { ... } }",
    description:
      "Declares a composite type with **fields** and **methods**. Inside methods, `this` is the current instance. Add an `init` method to set fields at creation. Create instances by calling the struct like a function; there is no `new`.",
    example: ex(`
struct BankAccount {
  var owner;
  var balance;

  func init(owner, initialDeposit = 0) {
    this.owner = owner;
    this.balance = initialDeposit;
  }

  func deposit(amount) {
    if (amount > 0) {
      this.balance += amount;
      return true;
    }
    return false;
  }
}

var account = BankAccount("John Doe", 1000);   // no \`new\` needed
account.deposit(500);
coreio.print(account.balance);                  // 1500
`),
    related: ["init", "this", "enum"],
  },

  enum: {
    category: "type",
    syntax: "enum Name { A, B = 10, func method() { ... } }",
    description:
      "Declares a fixed set of named values. Members can carry **custom values**, and an enum may have **methods** (use `this` to know which member you are). Enums pair naturally with `match`.",
    example: ex(`
enum HttpStatus {
  Ok = 200,
  NotFound = 404,
  ServerError = 500
}
coreio.print(HttpStatus.NotFound);        // 404

enum Color {
  Red,
  Green,
  Blue,

  func toHex() {
    match (this) {
      case Color.Red: return "#FF0000";
      case Color.Green: return "#00FF00";
      case Color.Blue: return "#0000FF";
    }
  }
}

var favorite = Color.Blue;
coreio.print(favorite.toHex());           // "#0000FF"
`),
    related: ["match", "case", "struct"],
  },

  this: {
    category: "type",
    syntax: "this.field",
    description:
      "Refers to the **current instance** inside a struct or enum method, and to the object itself inside an object method. Returning `this` lets you **chain** calls. Inside `try ... else { }`, `this.error` holds the caught error.",
    example: ex(`
var calculator = {
  value: 0,
  add: func(n) {
    this.value += n;
    return this;            // enables chaining
  },
  multiply: func(n) {
    this.value *= n;
    return this;
  }
};

calculator.add(5).multiply(2);
coreio.print(calculator.value);   // 10
`),
    related: ["struct", "enum", "try"],
  },

  typeof: {
    category: "operator",
    syntax: "typeof expression",
    description:
      "Returns the runtime type of a value as a string. It can tell integers from floats and recognises MyLang-specific kinds such as `struct`, `enum` and `error`.",
    example: ex(`
coreio.print(
  typeof true,        // boolean
  typeof nil,         // nil
  typeof {},          // object
  typeof [],          // array
  typeof 124,         // int
  typeof 123.0,       // float
  typeof 123n,        // bigint
  typeof "text",      // string
  typeof func() {},   // func
  typeof Color,       // enum
  typeof User,        // struct
  typeof symbol.iterator  // symbol
);
`),
    tip: 'A caught error reports `error`, so `typeof err == "error"` is a handy check in `catch`.',
    related: ["nil", "struct", "enum"],
  },

  // ── literals ──
  nil: {
    category: "literal",
    syntax: "nil",
    description:
      'The "no value" constant. Uninitialized variables are `nil`, optional chaining (`?.`) returns `nil` instead of failing, and `length(nil)` is `0`.',
    example: ex(`
var username;                          // nil
var profile = { name: "John" };

var avatar = profile?.avatar?.url;     // nil, no error
coreio.print(avatar == nil);           // true
coreio.print(length(nil));             // 0
`),
    related: ["var", "typeof"],
  },

  true: {
    category: "literal",
    syntax: "true",
    description:
      "The boolean literal `true`. Note that `&&` and `||` return one of their **operands**, not just a boolean, which makes `true`/`false` and defaults easy to combine.",
    example: ex(`
coreio.print(true && "hello");     // "hello"
coreio.print(5 > 3 && 2 < 1);      // false

var name = input || "Guest";       // default value idiom
`),
    related: ["false", "if"],
  },

  false: {
    category: "literal",
    syntax: "false",
    description:
      "The boolean literal `false`. With `||` it lets the right-hand side act as a **default value**.",
    example: ex(`
coreio.print(false || "default");  // "default"
coreio.print(!false);              // true

var enabled = false;
if (!enabled) {
  coreio.print("Feature is off");
}
`),
    related: ["true", "if"],
  },
};

// ───────────────────── Globals (need a context check) ─────────────────────

const GLOBAL_DOCS = {
  length: {
    category: "global function",
    syntax: "length(value)",
    description:
      "A universal size function that understands every type: characters of a string, elements of an array, properties of an object, parameters of a function, and so on.",
    example: ex(`
coreio.print(length("Hello"));        // 5   characters
coreio.print(length([1, 2, 3]));      // 3   elements
coreio.print(length({ a: 1, b: 2 })); // 2   properties
coreio.print(length(123.45));         // 5   length of "123.45"
coreio.print(length(nil));            // 0
coreio.print(length(func test(a, b) {})); // 2   parameters
`),
    tip: "For structs and enums it counts fields plus methods.",
    when: ({ after }) => /^\s*\(/.test(after),
  },

  process: {
    category: "global",
    syntax: "process",
    description:
      'Information about the running program. `process.version` is the MyLang version and `process.nodejs.version` the Node.js version underneath. After `import "os/system"`, `system` is the same object.',
    example: ex(`
import "coreio";
import "os/system";

coreio.print(process.version);          // current MyLang version
coreio.print(process.nodejs.version);   // current Node.js version
coreio.print(process == system);        // true
`),
    when: ({ after }) => after.startsWith("."),
  },

  symbol: {
    category: "global",
    syntax: "symbol.iterator   |   symbol.dispose",
    description:
      "Well-known keys that give objects special behaviour. `[symbol.iterator]` makes an object usable in `for ... in`, and `[symbol.dispose]` defines how `defer` cleans a value up.",
    example: ex(`
func Range(start, end) {
  return {
    [symbol.iterator]: func() {
      var current = start;
      return {
        next: func() {
          if (current >= end) {
            return { done: true, value: nil };
          }
          var value = current;
          current++;
          return { done: false, value: value };
        }
      };
    }
  };
}

for (var n in Range(0, 5)) {
  coreio.print(n);        // 0, 1, 2, 3, 4
}
`),
    when: ({ after }) => after.startsWith("."),
  },
};

// ───────────────────────── Members: owner.member ─────────────────────────

const MEMBER_DOCS = {
  "coreio.print": {
    category: "coreio",
    syntax: "coreio.print(...values)",
    description: "Prints any number of values to the console, separated by spaces.",
    example: ex(`
coreio.print("Total:", 2 + 3 * 4);   // Total: 14
coreio.print($"Hello, {name}!");
`),
  },
  "coreio.input": {
    category: "coreio",
    syntax: "coreio.input(prompt)",
    description:
      "Shows a prompt and returns what the user typed, as a **string**. Put a unary `+` in front to convert it to a number.",
    example: ex(`
var age = +coreio.input("How old are you? ");
coreio.print(age + 1);     // a number, not text
`),
  },
  "fs.readFile": {
    category: "fs",
    syntax: "fs.readFile(path, encoding?)",
    description:
      'Reads a file. Pass `"utf8"` to get text; wrap the call in `try` because the file may not exist.',
    example: ex(`
var text = try fs.readFile("notes.txt", "utf8") else {
  return "";
}
`),
  },
  "fs.writeFile": {
    category: "fs",
    syntax: "fs.writeFile(path, data)",
    description: "Writes data to a file, creating it if needed.",
    example: ex(`
fs.writeFile("hello.txt", "Hello from MyLang!");
`),
  },
  "strings.split": {
    category: "strings",
    syntax: "strings.split(text, separator)",
    description: "Splits a string into an array at every separator.",
    example: ex(`
var lines = strings.split("a,b,c", ",");
coreio.print(length(lines));   // 3
`),
  },
  "strings.trim": {
    category: "strings",
    syntax: "strings.trim(text)",
    description: "Removes whitespace from both ends of a string.",
    example: ex(`
coreio.print(strings.trim("  hi  "));   // "hi"
`),
  },
  "arrays.map": {
    category: "arrays",
    syntax: "arrays.map(array, fn)",
    description: "Returns a new array with `fn` applied to every element.",
    example: ex(`
var trimmed = arrays.map(lines, func(line) {
  return strings.trim(line);
});
`),
  },
  "time.sleep": {
    category: "time",
    syntax: "time.sleep(ms)",
    description:
      "Pauses for the given number of milliseconds. Inside a `spawn` block it only delays that task.",
    example: ex(`
var task = spawn {
  time.sleep(1000);
  return "done";
};
`),
  },
  "http.Server": {
    category: "net/http",
    syntax: "http.Server()",
    description:
      "Creates an HTTP server. Add routes with `.get` / `.post`, configure `.cors` and `.rateLimit`, then call `.listen`.",
    example: ex(`
var server = http.Server();

server.get("/user/:id", func(ctx) {
  return ctx.send({ userId: ctx.params.id });
});

server.listen(3000, func() {
  coreio.print("Server running on http://localhost:3000");
});
`),
  },

  "import.base": {
    category: "import",
    syntax: "import.base",
    description: "Directory of the main program.",
    example: "coreio.print(import.base);",
  },
  "import.main": {
    category: "import",
    syntax: "import.main",
    description: "Path of the main file.",
    example: "coreio.print(import.main);",
  },
  "import.cache": {
    category: "import",
    syntax: "import.cache",
    description: "Information about modules that have already been loaded and cached.",
    example: "coreio.print(import.cache);",
  },
  "import.paths": {
    category: "import",
    syntax: "import.paths",
    description: "All paths imported so far.",
    example: "coreio.print(import.paths);",
  },
  "import.resolve": {
    category: "import",
    syntax: "import.resolve(path)",
    description: "Turns a relative module path into the absolute path that would be loaded.",
    example: 'coreio.print(import.resolve("./file.ml"));',
  },
  "import.as": {
    category: "import",
    syntax: "import.as(path, type)",
    description: 'Loads a file as a specific type, such as `"json"` or `"buffer"`.',
    example: ex(`
var config = import.as("data.txt", "json");
var raw = import.as("binary.dat", "buffer");
`),
  },
  "symbol.iterator": {
    category: "symbol",
    syntax: "[symbol.iterator]: func() { ... }",
    description:
      "Define this method on an object to make it usable in `for ... in`. It must return an object with a `next()` method that yields `{ done, value }`.",
    example: "for (var n in Range(0, 5)) { coreio.print(n); }",
  },
  "symbol.dispose": {
    category: "symbol",
    syntax: "[symbol.dispose]: func() { ... }",
    description: "Cleanup method used together with the expression form of `defer`.",
    example: ex(`
return {
  content: data,
  [symbol.dispose]: func() { fs.close(fd); }
};
`),
  },
  "process.version": {
    category: "process",
    syntax: "process.version",
    description: "Current MyLang version.",
    example: "coreio.print(process.version);",
  },
  "nodejs.version": {
    category: "process",
    syntax: "process.nodejs.version",
    description: "Version of Node.js that MyLang is running on.",
    example: "coreio.print(process.nodejs.version);",
  },
};

// ───────────────────────── Standard library modules ─────────────────────────

// [identifier used in code, module path, purpose, key features]
const LIBRARIES = [
  ["coreio", "coreio", "Core input/output operations", "print, read, write"],
  ["syncbox", "syncbox", "Synchronization primitives", "channels, mutexes, wait groups"],
  ["strings", "strings", "String manipulation", "split, join, trim, search"],
  ["arrays", "arrays", "Array processing", "map, filter, reduce"],
  ["objects", "objects", "Object processing", "filter, find, groupBy"],
  ["random", "random", "Random number generation", "secure random, distributions"],
  ["path", "path", "File system path operations", "join, resolve, normalize"],
  ["os", "os", "Operating system interface", "environment, process management"],
  [
    "system",
    "os/system",
    "Operating system interface",
    "environment, process info (nodejs, mylang2)",
  ],
  ["uuid", "uuid", "UUID generation", "V4, V1, custom UUIDs"],
  ["iter", "iter", "Iterator patterns", "custom iterators, lazy evaluation"],
  ["collections", "collections", "Data structures", "Set, Map, advanced collections"],
  ["http", "net/http", "HTTP functionality", "client, server, middleware"],
  ["url", "net/url", "URL parsing", "parse, build, manipulate URLs"],
  ["colors", "utils/colors", "Color utilities", "terminal colors, formatting"],
  ["bytes", "bytes", "Binary data manipulation", "buffer operations, encoding"],
  ["fs", "fs", "File system operations", "read, write, directory management"],
  ["stream", "fs/stream", "File streaming", "efficient handling of large files"],
  ["events", "events", "Event handling", "event emitters, listeners"],
  ["runtime", "runtime", "Runtime introspection", "reflection, system information"],
  ["time", "time", "Time and date operations", "formatting, parsing, calculations"],
  ["numbers", "numbers", "Numeric operations", "math functions, conversions"],
  ["bigint", "numbers/bigint", "Big integer arithmetic", "large number calculations"],
];

const LIB_EXAMPLES = {
  coreio: ex(`
import "coreio";

coreio.print("Hello, MyLang2!");
var answer = coreio.input("Your name? ");
`),
  fs: ex(`
import "fs";

fs.writeFile("hello.txt", "Hi!");
var text = fs.readFile("hello.txt", "utf8");
`),
  strings: ex(`
import "strings";

var parts = strings.split("a,b,c", ",");
coreio.print(strings.trim("  hi  "));
`),
  arrays: ex(`
import "arrays";

var upper = arrays.map(["a", "b"], func(s) { return s + "!"; });
`),
  time: ex(`
import "time";

time.sleep(1000);   // pause for one second
`),
  http: ex(`
import "net/http";

var server = http.Server();
server.get("/", func(ctx) { return ctx.send("Hello!"); });
server.listen(3000);
`),
  system: ex(`
import "os/system";

coreio.print(system == process);   // true
`),
};

const LIB_DOCS = {};
for (const [word, module, purpose, features] of LIBRARIES) {
  LIB_DOCS[word] = {
    module,
    category: "standard library",
    syntax: `import "${module}";`,
    description: `**${purpose}.** Covers: ${features}.`,
    example: LIB_EXAMPLES[word] || `import "${module}";`,
  };
}

module.exports = { KEYWORD_DOCS, GLOBAL_DOCS, MEMBER_DOCS, LIB_DOCS };
