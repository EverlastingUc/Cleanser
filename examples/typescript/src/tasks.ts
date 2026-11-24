export type Task = {
  id: number;
  title: string;
  complete: boolean;
};

export function findOpenTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => !task.complete);
}
